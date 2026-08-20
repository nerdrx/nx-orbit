#!/usr/bin/env node
/*
 * steam-orbit — NX Orbit external emitter for Steam.
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 nerdrx
 *
 * A standalone Node CLI (ES modules, zero dependencies). You run it with YOUR
 * OWN Steam Web API key and YOUR OWN SteamID64. It calls exactly two official
 * endpoints — ISteamUser/GetFriendList (relationship=friend) and
 * ISteamUser/GetPlayerSummaries (100 steamids per call, Valve's documented
 * limit) — maps the result into Orbit `Person` upserts plus `presence`,
 * `status`, `location`, `nick`, `avatar` and `friend` `Observation`s, and POSTs
 * a single batch (SPEC §3) to the loopback ingest endpoint.
 *
 * Charter compliance (SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: the roster is literally GetFriendList for
 *     YOUR steamid, filtered to relationship "friend". No search, no crawling
 *     of friends-of-friends, no group scraping, no non-friend ever touched.
 *   - Surface-only: the official Web API with the operator's own key returns
 *     exactly the persona card Steam already renders to a friend — persona
 *     name, avatar, persona state, and the game the person is broadcasting.
 *     No unofficial endpoints, no HTML scraping, no hidden fields.
 *     `realname` and `timecreated` come back in the same payload and are
 *     deliberately DROPPED: SPEC §2.1 has no home for them and meta is not a
 *     smuggling channel.
 *   - Observations, not conclusions: every record is a timestamped fact Steam
 *     stated. personastate 3/4 ("away"/"snooze") map to `idle`; there is no
 *     Steam equivalent of VRChat's joinme/askme rings, so those are never
 *     emitted (SPEC §2.2: omit rather than fake).
 *   - Local delivery only: the only outbound host is api.steampowered.com; the
 *     batch goes to 127.0.0.1 with a bearer token. No phone-home.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = "steam-orbit";
const VERSION = "1.0.0";
const SOURCE = "steam";

const API_HOST = "https://api.steampowered.com";
export const SUMMARIES_CHUNK = 100; // Valve's documented cap for GetPlayerSummaries
const HTTP_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = {
        port: 8477,
        token: null,
        key: null,
        steamid: null,
        fixture: null,
        dryRun: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") o.dryRun = true;
        else if (a === "--help" || a === "-h") o.help = true;
        else if (a === "--port") o.port = Number(argv[++i]);
        else if (a === "--token") o.token = argv[++i];
        else if (a === "--key") o.key = argv[++i];
        else if (a === "--steamid") o.steamid = argv[++i];
        else if (a === "--from-fixture") o.fixture = argv[++i];
        else if (a.startsWith("--port=")) o.port = Number(a.slice(7));
        else if (a.startsWith("--token=")) o.token = a.slice(8);
        else if (a.startsWith("--key=")) o.key = a.slice(6);
        else if (a.startsWith("--steamid=")) o.steamid = a.slice(10);
        else if (a.startsWith("--from-fixture=")) o.fixture = a.slice(15);
        else { console.error(`unknown argument: ${a}`); o.help = true; }
    }
    return o;
}

const HELP = `steam-orbit ${VERSION} — NX Orbit emitter for YOUR Steam friends list.

Usage:
  node index.js --key <steam api key> --steamid <your steamid64> [--dry-run] [--port N] [--token TOKEN]
  node index.js --from-fixture <file> --dry-run

Options:
  --key <KEY>          Your own Steam Web API key (https://steamcommunity.com/dev/apikey).
                       Falls back to $STEAM_API_KEY.
  --steamid <ID>       Your own 17-digit SteamID64. Falls back to $STEAM_ID.
  --from-fixture <f>   Read saved GetFriendList + GetPlayerSummaries JSON from a
                       file instead of calling Steam (offline testing).
  --dry-run            Print the batch JSON to stdout instead of POSTing it.
                       Neither reads nor writes the snapshot, so it always shows
                       the full first-run baseline and is repeatable.
  --port N             Loopback ingest port (default 8477).
  --token TOKEN        Orbit ingest bearer token. Resolution order:
                         --token  >  $NX_ORBIT_TOKEN  >  ~/.config/nx-orbit/ingest.token

This tool ONLY reads your own friends list (relationship=friend) and the persona
card Steam already shows you for each of those friends. It never searches,
crawls, or touches an account that is not your friend.`;

// -------------------------------------------------------------- config

const CONFIG_DIR = join(homedir(), ".config", "nx-orbit");
const TOKEN_FILE = join(CONFIG_DIR, "ingest.token");
const SNAPSHOT_FILE = join(CONFIG_DIR, "steam-orbit.snapshot.json");

async function resolveToken(flagToken) {
    if (flagToken) return flagToken.trim();
    if (process.env.NX_ORBIT_TOKEN) return process.env.NX_ORBIT_TOKEN.trim();
    try {
        return (await readFile(TOKEN_FILE, "utf8")).trim();
    } catch {
        return null;
    }
}

// -------------------------------------------------- persona state map
//
// SPEC §2.2 status enum: online | active | idle | joinme | askme | busy | offline.
// Steam's personastate is a small closed enum; the two rings Orbit knows that
// Steam does NOT have (joinme / askme) are never produced — a plugin without a
// true equivalent omits `status` rather than mapping to the nearest-looking slot.
//
//   0 Offline           → presence offline
//   1 Online            → presence online
//   2 Busy              → presence online + status busy
//   3 Away              → presence online + status idle
//   4 Snooze            → presence online + status idle
//   5 Looking to trade  → presence online   (no status equivalent → omitted)
//   6 Looking to play   → presence online   (no status equivalent → omitted)
export const PERSONA_STATE = {
    0: { label: "offline", presence: "offline" },
    1: { label: "online", presence: "online" },
    2: { label: "busy", presence: "online", status: "busy" },
    3: { label: "away", presence: "online", status: "idle" },
    4: { label: "snooze", presence: "online", status: "idle" },
    5: { label: "looking to trade", presence: "online" },
    6: { label: "looking to play", presence: "online" },
};

// --------------------------------------------------------- steam http

class SteamHttpError extends Error {
    constructor(status, body, what) {
        super(`Steam ${what} returned HTTP ${status}`);
        this.status = status;
        this.body = body;
        this.what = what;
    }
}

/** GET a JSON document over https. Never logs or echoes the API key. */
function apiGet(url, what) {
    return new Promise((resolve, reject) => {
        const req = httpsGet(
            url,
            { headers: { "User-Agent": `${PLUGIN}/${VERSION}`, Accept: "application/json" } },
            res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", c => (data += c));
                res.on("end", () => {
                    if (res.statusCode !== 200) return reject(new SteamHttpError(res.statusCode, data, what));
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Steam ${what} returned invalid JSON: ${e.message}`));
                    }
                });
            }
        );
        req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`Steam ${what} timed out after ${HTTP_TIMEOUT_MS}ms`)));
        req.on("error", reject);
    });
}

function apiUrl(path, params) {
    const u = new URL(API_HOST + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
}

/** Human-readable cause for a Steam HTTP failure — the common ones are self-inflicted. */
function explainSteamError(e) {
    if (!(e instanceof SteamHttpError)) return e.message;
    switch (e.status) {
        case 400:
            return `Steam rejected the request (400) on ${e.what} — is --steamid a 17-digit SteamID64 (not a vanity URL name)?`;
        case 401:
            return `Steam refused the API key (401) on ${e.what} — check --key / $STEAM_API_KEY at https://steamcommunity.com/dev/apikey`;
        case 403:
            return (
                `Steam refused (403) on ${e.what}. Either the API key is wrong, or the profile is private: ` +
                `GetFriendList only answers when your own "My Friends List" privacy is set to Public ` +
                `(Steam → Profile → Edit Profile → Privacy Settings).`
            );
        case 429:
            return `Steam rate-limited you (429) on ${e.what} — the Web API allows ~100k calls/day; wait and re-run.`;
        case 500:
        case 502:
        case 503:
            return `Steam is having a bad day (${e.status}) on ${e.what} — transient, re-run later.`;
        default:
            return `Steam ${e.what} returned HTTP ${e.status}.`;
    }
}

// --------------------------------------------------------- fetching

/** Your friends list, relationship "friend" only. Returns [{steamid, friendSince}]. */
function extractFriends(payload) {
    const list = Array.isArray(payload)
        ? payload
        : payload?.friendslist?.friends ?? payload?.friends ?? null;
    if (!Array.isArray(list)) return null;
    return list
        .filter(f => (f?.relationship ?? "friend") === "friend")
        .map(f => ({
            steamid: String(f.steamid ?? "").trim(),
            friendSince: Number(f.friend_since) > 0 ? Number(f.friend_since) * 1000 : null,
        }))
        .filter(f => f.steamid);
}

function extractPlayers(payload) {
    const list = Array.isArray(payload) ? payload : payload?.response?.players ?? payload?.players ?? null;
    return Array.isArray(list) ? list : null;
}

export function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

async function fetchLive(key, steamid) {
    const friendsPayload = await apiGet(
        apiUrl("/ISteamUser/GetFriendList/v1/", { key, steamid, relationship: "friend" }),
        "GetFriendList"
    );
    const friends = extractFriends(friendsPayload);
    if (!friends) throw new Error("GetFriendList returned no friendslist — is your friends list set to Public?");

    // Ask for the operator too: their own persona card is the heatmap's "me" axis.
    const ids = [steamid, ...friends.map(f => f.steamid).filter(id => id !== steamid)];
    const players = [];
    for (const group of chunk(ids, SUMMARIES_CHUNK)) {
        const payload = await apiGet(
            apiUrl("/ISteamUser/GetPlayerSummaries/v2/", { key, steamids: group.join(",") }),
            "GetPlayerSummaries"
        );
        const got = extractPlayers(payload);
        if (!got) throw new Error("GetPlayerSummaries returned no players array.");
        players.push(...got);
    }
    return { friends, players };
}

async function fetchFixture(path, steamidFlag) {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const friends = extractFriends(
        parsed.friends ?? parsed.friendslist ?? parsed.GetFriendList ?? parsed
    );
    const players = extractPlayers(
        parsed.summaries ?? parsed.players ?? parsed.GetPlayerSummaries ?? parsed
    );
    if (!friends) throw new Error(`fixture "${path}" has no GetFriendList payload (friends / friendslist / GetFriendList)`);
    if (!players) throw new Error(`fixture "${path}" has no GetPlayerSummaries payload (summaries / players / GetPlayerSummaries)`);
    const steamid = String(steamidFlag ?? parsed.steamid ?? "").trim();
    if (!steamid) throw new Error(`fixture "${path}" has no "steamid" — pass --steamid to say which player is you`);
    return { friends, players, steamid };
}

// --------------------------------------------------------- snapshot

async function loadSnapshot() {
    try {
        const snap = JSON.parse(await readFile(SNAPSHOT_FILE, "utf8"));
        return snap && typeof snap === "object" ? snap : {};
    } catch {
        return {}; // no prior run
    }
}

async function saveSnapshot(snap) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
}

// ------------------------------------------------------ batch build

function nonEmpty(v) {
    const s = typeof v === "string" ? v.trim() : "";
    return s || null;
}

/**
 * Build the batch.
 *
 * Presence / status / location are the CURRENT persona state: the Web API hands
 * back a snapshot, not history, so `ts` is now (documented in the README — run
 * this on a timer and the heatmap fills in over time).
 *
 * nick / avatar / friend observations are diffed against the snapshot, so a
 * re-run with nothing changed emits no change events.
 */
export function buildBatch({ friends, players, steamid, snapshot = {}, now = Date.now() }) {
    const persons = [];
    const observations = [];
    const nextSnapshot = {};
    const byId = new Map(players.map(p => [String(p.steamid), p]));
    const friendSince = new Map(friends.map(f => [f.steamid, f.friendSince]));
    const stats = { friends: 0, private: 0, inGame: 0, states: {} };

    // ---- the operator: the reserved `self` person (SPEC §2.1), never a friend row.
    const me = byId.get(String(steamid));
    persons.push({ source: "self", sourceId: "me", handle: "you", displayName: "(you)" });
    if (me && typeof me.personastate === "number" && PERSONA_STATE[me.personastate]) {
        const map = PERSONA_STATE[me.personastate];
        observations.push({ source: "self", sourceId: "me", kind: "presence", status: map.presence, ts: now });
        if (map.status) observations.push({ source: "self", sourceId: "me", kind: "status", status: map.status, ts: now });
        const game = nonEmpty(me.gameextrainfo);
        if (game) observations.push({ source: "self", sourceId: "me", kind: "location", place: game, ts: now });
    }

    // ---- your friends
    for (const f of friends) {
        if (f.steamid === String(steamid)) continue; // you are `self`, not your own friend
        const p = byId.get(f.steamid);
        if (!p) continue; // no persona card came back (deleted/limited account) — invent nothing
        stats.friends++;

        const name = nonEmpty(p.personaname) ?? f.steamid;
        const avatar = nonEmpty(p.avatarfull);
        const person = { source: SOURCE, sourceId: f.steamid, handle: name, displayName: name };
        if (avatar) person.avatarUrl = avatar;
        persons.push(person);

        // Presence / status / location — only when Steam actually told us a state.
        // A private profile returns no personastate; we emit nothing rather than
        // guessing "offline" (SPEC §0.3: never a datum the platform didn't give).
        const map = typeof p.personastate === "number" ? PERSONA_STATE[p.personastate] : null;
        if (map) {
            stats.states[map.label] = (stats.states[map.label] ?? 0) + 1;
            observations.push({ source: SOURCE, sourceId: f.steamid, kind: "presence", status: map.presence, ts: now });
            if (map.status)
                observations.push({ source: SOURCE, sourceId: f.steamid, kind: "status", status: map.status, ts: now });
        } else {
            stats.private++;
        }
        // The game they are broadcasting to friends — same category as a VRChat
        // world name: a place THEY published, counted, never resolved further.
        const game = nonEmpty(p.gameextrainfo);
        if (game) {
            stats.inGame++;
            observations.push({ source: SOURCE, sourceId: f.steamid, kind: "location", place: game, ts: now });
        }

        // Roster / profile changes vs the last accepted run.
        const prev = snapshot[f.steamid];
        if (!prev) {
            observations.push({
                source: SOURCE,
                sourceId: f.steamid,
                kind: "friend",
                ts: friendSince.get(f.steamid) ?? now, // Steam tells us when you became friends
                meta: { state: "added" },
            });
        } else {
            if (prev.name && prev.name !== name)
                observations.push({
                    source: SOURCE, sourceId: f.steamid, kind: "nick",
                    text: name, ts: now, meta: { previous: prev.name },
                });
            if (avatar && prev.avatar && prev.avatar !== avatar)
                observations.push({ source: SOURCE, sourceId: f.steamid, kind: "avatar", ts: now, text: avatar });
        }
        nextSnapshot[f.steamid] = { name, avatar: avatar ?? null, since: friendSince.get(f.steamid) ?? null };
    }

    // ---- friends who are no longer on your list (roster change, SPEC §2.2 `friend`).
    // Their Person is re-emitted from the snapshot so the observation always has a
    // person row to hang off (SPEC §3: no observation about an unknown person).
    let removed = 0;
    if (stats.friends > 0) {
        for (const [id, prev] of Object.entries(snapshot)) {
            if (nextSnapshot[id] || !prev?.name) continue;
            removed++;
            const person = { source: SOURCE, sourceId: id, handle: prev.name, displayName: prev.name };
            if (prev.avatar) person.avatarUrl = prev.avatar;
            persons.push(person);
            observations.push({
                source: SOURCE, sourceId: id, kind: "friend", ts: now, meta: { state: "removed" },
            });
        }
    }
    stats.removed = removed;

    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: now, persons, observations };
    return { batch, nextSnapshot, stats };
}

// ------------------------------------------------------------ POST

function postBatch(port, token, batch) {
    const body = Buffer.from(JSON.stringify(batch));
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: "127.0.0.1",
                port,
                path: "/ingest",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": body.length,
                    Authorization: "Bearer " + token,
                },
            },
            res => {
                let data = "";
                res.on("data", c => (data += c));
                res.on("end", () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ------------------------------------------------------------ main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(HELP);
        return 0;
    }

    // ---- gather the two API payloads (live, or a saved fixture for offline tests)
    let friends, players, steamid;
    if (opts.fixture) {
        try {
            ({ friends, players, steamid } = await fetchFixture(opts.fixture, opts.steamid));
        } catch (e) {
            console.error(`error: could not read fixture "${opts.fixture}": ${e.message}`);
            return 1;
        }
    } else {
        const key = (opts.key ?? process.env.STEAM_API_KEY ?? "").trim();
        steamid = (opts.steamid ?? process.env.STEAM_ID ?? "").trim();
        if (!key) {
            console.error(
                "error: no Steam Web API key. Pass --key or set $STEAM_API_KEY. " +
                "Get your own at https://steamcommunity.com/dev/apikey (it is yours; never share it)."
            );
            return 1;
        }
        if (!/^\d{17}$/.test(steamid)) {
            console.error(
                `error: --steamid must be your own 17-digit SteamID64${steamid ? ` (got "${steamid}")` : ""}. ` +
                "A vanity URL name is not a SteamID64 — open your profile, it is the number in /profiles/<id>/."
            );
            return 1;
        }
        try {
            ({ friends, players } = await fetchLive(key, steamid));
        } catch (e) {
            console.error(`error: ${explainSteamError(e)}`);
            return 1;
        }
    }

    if (!friends.length) {
        console.error(
            "error: your friends list came back empty. Steam returns an empty list when " +
            '"My Friends List" is not Public in your privacy settings.'
        );
        return 1;
    }

    // --dry-run neither reads nor writes the snapshot: it always shows the full
    // first-run baseline, so it is repeatable and safe to paste into a bug report.
    const snapshot = opts.dryRun ? {} : await loadSnapshot();
    const now = Date.now();
    const { batch, nextSnapshot, stats } = buildBatch({ friends, players, steamid, snapshot, now });

    if (opts.dryRun) {
        console.log(JSON.stringify(batch, null, 2));
        const states = Object.entries(stats.states).map(([k, v]) => `${k}:${v}`).join(" ") || "none";
        console.error(
            `\n[dry-run] ${batch.persons.length} persons, ${batch.observations.length} observations ` +
            `(${stats.friends} friends, ${stats.inGame} in-game, ${stats.private} without a visible state).\n` +
            `[dry-run] persona states: ${states}. Not POSTing, snapshot untouched.`
        );
        return 0;
    }

    const token = await resolveToken(opts.token);
    if (!token) {
        console.error(
            "error: no ingest token. Provide --token, set $NX_ORBIT_TOKEN, or write it to " +
            TOKEN_FILE + " (copy it from Orbit → Settings → Sources)."
        );
        return 1;
    }

    let res;
    try {
        res = await postBatch(opts.port, token, batch);
    } catch (e) {
        if (e.code === "ECONNREFUSED") {
            console.error(`error: connection refused at 127.0.0.1:${opts.port} — is NX Orbit running?`);
        } else {
            console.error(`error: POST failed: ${e.message}`);
        }
        return 1;
    }

    if (res.status === 200) {
        await saveSnapshot(nextSnapshot); // only advance snapshot on an accepted batch
        console.log(
            `ok: ${res.body || "{}"}  (${batch.persons.length} persons, ${batch.observations.length} observations, ` +
            `${stats.friends} friends, ${stats.inGame} in-game)`
        );
        return 0;
    }
    if (res.status === 401) {
        console.error("error: 401 unauthorized — the ingest token is wrong or was rotated in Orbit → Sources.");
        return 1;
    }
    if (res.status === 422) {
        console.error("error: 422 — the core rejected the batch (schema/consent). Details:\n" + res.body);
        return 1;
    }
    console.error(`error: unexpected response ${res.status}: ${res.body}`);
    return 1;
}

// Only run when invoked as a CLI, so tests can import buildBatch/PERSONA_STATE.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("fatal:", e);
        process.exit(1);
    });
}
