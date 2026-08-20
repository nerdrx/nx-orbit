/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * vencord-orbit-bridge — NX Orbit external emitter for Discord.
 *
 * It streams to NX Orbit ONLY what your own logged-in Discord client already
 * shows you about your OWN friends: your friends list, and the presence /
 * custom-status those friends broadcast to you. It batches that into Orbit
 * `Person` upserts + `Observation`s and POSTs them to Orbit's loopback ingest
 * endpoint (127.0.0.1). Nothing else leaves the machine.
 *
 * Charter compliance (Orbit SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: it enumerates RelationshipStore friends
 *     (type === FRIEND) ONLY. Never blocked / pending / strangers / guild
 *     members. Every read is guarded by isFriend().
 *   - Surface-only: presence status, the custom-status text, display name and
 *     avatar — exactly what Discord renders for a friend. It NEVER reads message
 *     content, DMs, servers, or any hidden field.
 *   - Observations, not conclusions: it emits presence/status/nick/avatar events
 *     with real timestamps. No scores, no inference.
 *   - Local delivery only: POST to 127.0.0.1 with a bearer token. No phone-home.
 *
 * ---------------------------------------------------------------------------
 * Batch it emits (Orbit SPEC §3 envelope — validated against the core schema):
 * {
 *   "plugin": "vencord-orbit-bridge", "version": "1.0.0", "emittedAt": 1690000000000,
 *   "persons": [
 *     { "source":"discord", "sourceId":"228534106599948289", "handle":"friend",
 *       "displayName":"Friend", "avatarUrl":"https://cdn.discordapp.com/avatars/…" }
 *   ],
 *   "observations": [
 *     { "source":"discord", "sourceId":"228534106599948289", "kind":"presence", "status":"online", "ts":1690000000000 },
 *     { "source":"discord", "sourceId":"228534106599948289", "kind":"status", "status":"busy", "ts":1690000000000 },
 *     { "source":"discord", "sourceId":"228534106599948289", "kind":"status", "text":"🏖 back on the 20th", "ts":1690000000000 },
 *     { "source":"discord", "sourceId":"228534106599948289", "kind":"nick", "text":"NewName", "meta":{"previous":"OldName"}, "ts":1690000000000 }
 *   ]
 * }
 * ---------------------------------------------------------------------------
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, PresenceStore, RelationshipStore, UserStore } from "@webpack/common";

const PLUGIN = "vencord-orbit-bridge";
const VERSION = "1.0.0";
const SOURCE = "discord";

// Discord RelationshipType.FRIEND. We ONLY ever emit for this type.
const REL_FRIEND = 1;
// Discord ActivityType.CUSTOM — the custom-status ("on holiday 🏖") activity.
const ACT_CUSTOM = 4;
// Discord statuses that mean "not online".
const OFFLINE = new Set(["offline", "invisible", "unknown"]);

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Emit friend presence/status to NX Orbit. Turn off to stop all outbound batches.",
        default: true,
    },
    ingestPort: {
        type: OptionType.NUMBER,
        description: "NX Orbit loopback ingest port.",
        default: 8477,
    },
    ingestToken: {
        type: OptionType.STRING,
        description: "NX Orbit ingest token — paste it from Orbit → Settings → Sources.",
        default: "",
    },
    flushIntervalSec: {
        type: OptionType.NUMBER,
        description: "How often (seconds) to POST the batched records to Orbit.",
        default: 30,
    },
});

// --- Observation kinds & the Orbit record types (shapes only; SPEC §2) -------

type ObsKind = "presence" | "status" | "location" | "bio" | "nick" | "avatar" | "friend";
interface Person {
    source: "discord";
    sourceId: string;
    handle?: string;
    displayName?: string;
    avatarUrl?: string;
}
interface Observation {
    source: "discord";
    sourceId: string;
    kind: ObsKind;
    ts: number;
    status?: "online" | "active" | "idle" | "joinme" | "askme" | "busy" | "offline";
    text?: string;
    meta?: Record<string, unknown>;
}

// Map a Discord presence-ring status to an Orbit `status`-kind enum value.
// idle/dnd collapse to "online" for the *presence* kind (see syncFriend); this
// mapping is ONLY for the extra status-ring observation.
//
// Per SPEC §2.2, a plugin omits `status` rather than mapping to a nearest-looking
// slot: `joinme`/`askme` are VRChat rings with no Discord equivalent, so Discord
// never emits them. dnd→busy and idle→idle are true equivalents.
function ringStatus(discord: string): Observation["status"] | undefined {
    if (discord === "dnd") return "busy";
    if (discord === "idle") return "idle";
    return undefined; // online/offline carried by the presence kind, not here
}

// --- outbound queue ----------------------------------------------------------

const obsQueue: Observation[] = [];
const dirtyPersons = new Set<string>(); // ids whose Person upsert must ride along
// last-seen snapshot per friend, to emit change events (not re-emit steady state)
const snap = new Map<string, { status: string; custom: string; name: string; avatar: string; }>();

let flushTimer: ReturnType<typeof setInterval> | undefined;

function isFriend(id: string): boolean {
    try {
        return RelationshipStore.getRelationshipType(id) === REL_FRIEND;
    } catch {
        return false;
    }
}

function friendIds(): string[] {
    try {
        // getFriendIDs() already returns friends only; the isFriend guard is belt-and-braces.
        return (RelationshipStore.getFriendIDs() ?? []).filter(isFriend);
    } catch {
        return [];
    }
}

function personOf(id: string): Person | null {
    const u: any = UserStore.getUser(id);
    if (!u) return null;
    const person: Person = {
        source: SOURCE,
        sourceId: id,
        handle: u.username,
        displayName: u.globalName || u.username,
    };
    const url = u.getAvatarURL?.(undefined, 128);
    if (url) person.avatarUrl = url;
    return person;
}

function statusOf(id: string): string {
    try {
        return PresenceStore.getStatus(id) ?? "offline";
    } catch {
        return "offline";
    }
}

// The custom-status text ("🏖 back on the 20th"), emoji included, verbatim.
function customOf(id: string): string {
    try {
        const acts: any[] = PresenceStore.getActivities(id) ?? [];
        const c = acts.find(a => a.type === ACT_CUSTOM);
        if (!c) return "";
        return `${c.emoji?.name ? c.emoji.name + " " : ""}${c.state ?? ""}`.trim();
    } catch {
        return "";
    }
}

function enqueue(o: Observation) {
    obsQueue.push(o);
    dirtyPersons.add(o.sourceId); // guarantee the person rides along (SPEC §3)
}

/**
 * Diff one friend's current surface against the snapshot; enqueue observations.
 * When `seed` is true (initial sight) we baseline current presence + custom
 * status (useful current-state), but do NOT emit nick/avatar as false "changes".
 */
function syncFriend(id: string, seed = false) {
    if (!isFriend(id)) return; // hard guard: never touch a non-friend
    const u: any = UserStore.getUser(id);
    if (!u) return;

    const status = statusOf(id);
    const custom = customOf(id);
    const name = u.globalName || u.username || "";
    const avatar = u.avatar ?? "";
    const prev = snap.get(id);
    const now = Date.now();

    // presence: collapse to online/offline (idle/dnd count as online).
    const online = !OFFLINE.has(status);
    if (seed || !prev || (!OFFLINE.has(prev.status)) !== online) {
        enqueue({ source: SOURCE, sourceId: id, kind: "presence", status: online ? "online" : "offline", ts: now });
    }

    // status ring: emit a status observation for dnd/idle (their away-ness).
    if (seed || !prev || prev.status !== status) {
        const rs = ringStatus(status);
        if (rs) enqueue({ source: SOURCE, sourceId: id, kind: "status", status: rs, ts: now });
    }

    // custom status text — the "on holiday" surface, verbatim (emoji included).
    if (custom && (seed || !prev || prev.custom !== custom)) {
        enqueue({ source: SOURCE, sourceId: id, kind: "status", text: custom, ts: now });
    }

    // nick / avatar are change-only (no baseline emit on first sight).
    if (prev && name && name !== prev.name) {
        enqueue({ source: SOURCE, sourceId: id, kind: "nick", text: name, ts: now, meta: { previous: prev.name } });
    }
    if (prev && avatar !== prev.avatar) {
        enqueue({ source: SOURCE, sourceId: id, kind: "avatar", ts: now });
    }

    snap.set(id, { status, custom, name, avatar });
    if (seed || !prev) dirtyPersons.add(id); // ensure the roster upsert is sent
}

// --- flush -------------------------------------------------------------------

async function flush() {
    if (!settings.store.enabled) return;
    const token = settings.store.ingestToken?.trim();
    if (!token) return; // not configured yet — stay silent, don't crash Discord

    // Always keep the person set current so avatar/name upserts land alongside obs.
    const persons: Person[] = [];
    for (const id of dirtyPersons) {
        const p = personOf(id);
        if (p) persons.push(p);
    }
    const observations = obsQueue.slice();
    if (!persons.length && !observations.length) return; // nothing to send

    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: Date.now(), persons, observations };

    let res: Response;
    try {
        res = await fetch(`http://127.0.0.1:${settings.store.ingestPort}/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
            body: JSON.stringify(batch),
        });
    } catch (e) {
        // connection refused / CSP / Orbit down — keep the queue for next flush.
        console.warn("[orbit-bridge] ingest POST failed (is NX Orbit running?):", e);
        return;
    }

    if (res.ok) {
        obsQueue.length = 0;        // drain only on success
        dirtyPersons.clear();
        return;
    }
    if (res.status === 401) {
        console.warn("[orbit-bridge] 401 unauthorized — check the ingest token in Orbit → Sources.");
        return; // keep queue; user needs to fix the token
    }
    if (res.status === 422) {
        // Batch rejected by schema/consent. Drop it (don't loop forever) and log.
        console.warn("[orbit-bridge] 422 rejected by core:", await res.text().catch(() => ""));
        obsQueue.length = 0;
        dirtyPersons.clear();
        return;
    }
    console.warn("[orbit-bridge] unexpected ingest response:", res.status);
}

// --- flux handlers -----------------------------------------------------------

function onPresenceUpdate(e: any) {
    // PRESENCE_UPDATES batches; PRESENCE_UPDATE is singular. Handle both.
    const ids: string[] = e?.updates
        ? e.updates.map((u: any) => u.user?.id ?? u.userId)
        : [e?.user?.id ?? e?.userId];
    for (const id of ids) if (id && isFriend(id)) syncFriend(id);
}

function onRelationshipAdd(e: any) {
    const id = e?.relationship?.id ?? e?.id;
    if (!id || e?.relationship?.type !== REL_FRIEND) return;
    enqueue({ source: SOURCE, sourceId: id, kind: "friend", ts: Date.now(), meta: { state: "added" } });
    syncFriend(id, true);
}

function onRelationshipRemove(e: any) {
    const id = e?.relationship?.id ?? e?.id;
    if (!id) return;
    // They were your friend; record the roster change. Only if we can name them.
    if (UserStore.getUser(id)) {
        dirtyPersons.add(id);
        enqueue({ source: SOURCE, sourceId: id, kind: "friend", ts: Date.now(), meta: { state: "removed" } });
    }
    snap.delete(id);
}

export default definePlugin({
    name: "OrbitBridge",
    description:
        "Streams your Discord friends list + the presence/custom-status they already broadcast to you into NX Orbit (local loopback). Friends-only, surface-only: never reads messages, servers, or non-friends.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    start() {
        // Seed the current roster + presence so Orbit knows who's on right now.
        for (const id of friendIds()) syncFriend(id, true);

        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdate);
        FluxDispatcher.subscribe("PRESENCE_UPDATE", onPresenceUpdate);
        FluxDispatcher.subscribe("RELATIONSHIP_ADD", onRelationshipAdd);
        FluxDispatcher.subscribe("RELATIONSHIP_REMOVE", onRelationshipRemove);

        const secs = Math.max(5, Number(settings.store.flushIntervalSec) || 30);
        flushTimer = setInterval(flush, secs * 1000);
        void flush(); // best-effort initial push
    },

    stop() {
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdate);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATE", onPresenceUpdate);
        FluxDispatcher.unsubscribe("RELATIONSHIP_ADD", onRelationshipAdd);
        FluxDispatcher.unsubscribe("RELATIONSHIP_REMOVE", onRelationshipRemove);
        if (flushTimer) clearInterval(flushTimer);
        flushTimer = undefined;
        obsQueue.length = 0;
        dirtyPersons.clear();
        snap.clear();
    },
});
