#!/usr/bin/env node
/*
 * matrix-orbit — NX Orbit external emitter for Matrix.
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 nerdrx
 *
 * A standalone Node CLI (ES modules, zero dependencies). It talks to YOUR OWN
 * homeserver with YOUR OWN access token, works out who your Matrix contacts are
 * from YOUR OWN `m.direct` account data, and POSTs one batch (SPEC §3) of
 * `Person` upserts + presence/status/nick/avatar/friend `Observation`s to the
 * loopback ingest endpoint.
 *
 * Charter compliance (SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: Matrix has no friends list, so "friend" is
 *     defined honestly as *a user you share a direct-message room with*, read
 *     from `m.direct` — the operator's own DM mapping, written by the operator's
 *     own clients. It NEVER enumerates the membership of public or group rooms:
 *     that would be collecting strangers, which §0.1 forbids outright.
 *   - Surface-only: displayname, avatar and the presence/status_msg the person
 *     broadcasts — exactly what Element shows you next to their name.
 *   - Observations, not conclusions: presence transitions and verbatim status
 *     messages, with real timestamps derived from `last_active_ago`. No scores,
 *     no sentiment, no inference. No message content is read — ever. This plugin
 *     never calls /messages, /sync timelines, or any room event endpoint.
 *   - Local delivery only: POSTs to 127.0.0.1 with a bearer token. No phone-home.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN = "matrix-orbit";
const VERSION = "1.0.0";
const SOURCE = "matrix";

const THUMB_W = 96;
const THUMB_H = 96;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = {
        port: 8477,
        token: null,
        homeserver: null,
        matrixToken: null,
        fixture: null,
        dryRun: false,
        help: false,
    };
    const eat = (a, name, key, cast) => {
        if (!a.startsWith(name + "=")) return false;
        o[key] = cast ? cast(a.slice(name.length + 1)) : a.slice(name.length + 1);
        return true;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") o.dryRun = true;
        else if (a === "--help" || a === "-h") o.help = true;
        else if (a === "--port") o.port = Number(argv[++i]);
        else if (a === "--token") o.token = argv[++i];
        else if (a === "--homeserver") o.homeserver = argv[++i];
        else if (a === "--matrix-token") o.matrixToken = argv[++i];
        else if (a === "--from-fixture") o.fixture = argv[++i];
        else if (eat(a, "--port", "port", Number)) ;
        else if (eat(a, "--token", "token")) ;
        else if (eat(a, "--homeserver", "homeserver")) ;
        else if (eat(a, "--matrix-token", "matrixToken")) ;
        else if (eat(a, "--from-fixture", "fixture")) ;
        else { console.error(`unknown argument: ${a}`); o.help = true; }
    }
    return o;
}

const HELP = `matrix-orbit ${VERSION} — NX Orbit emitter for YOUR Matrix DM contacts and their presence.

Usage:
  node index.js --homeserver https://matrix.org [--dry-run] [--port N] [--token TOKEN]
  node index.js --from-fixture fixture.sample.json --dry-run

Options:
  --homeserver URL     Your own homeserver base URL (or $MATRIX_HOMESERVER).
  --matrix-token TOK   Your own access token (or $MATRIX_TOKEN, or
                       ~/.config/nx-orbit/matrix.token). In Element:
                       Settings -> Help & About -> Access Token.
                       WARNING: an access token is as powerful as your password.
                       Put it in the token file, not in your shell history.
  --from-fixture FILE  Read canned API responses from FILE instead of the
                       network. For offline testing of the mapping logic.
  --dry-run            Print the batch JSON to stdout instead of POSTing it.
                       Does not read or write the snapshot, so it is repeatable.
  --port N             Loopback ingest port (default 8477).
  --token TOKEN        Orbit ingest bearer token. Resolution order:
                         --token  >  $NX_ORBIT_TOKEN  >  ~/.config/nx-orbit/ingest.token

Your contacts are the users you share a direct-message room with, read from your
own m.direct account data. Members of public or group rooms are never enumerated.
Many homeservers disable presence; that degrades to "roster only", not an error.`;

// -------------------------------------------------------------- config

const CONFIG_DIR = join(homedir(), ".config", "nx-orbit");
const TOKEN_FILE = join(CONFIG_DIR, "ingest.token");
const MATRIX_TOKEN_FILE = join(CONFIG_DIR, "matrix.token");

function snapshotFile(isFixture) {
    return join(CONFIG_DIR, `${PLUGIN}.snapshot${isFixture ? ".fixture" : ""}.json`);
}

async function readTrimmed(path) {
    try {
        return (await readFile(path, "utf8")).trim() || null;
    } catch {
        return null;
    }
}

async function resolveToken(flagToken) {
    if (flagToken) return flagToken.trim();
    if (process.env.NX_ORBIT_TOKEN) return process.env.NX_ORBIT_TOKEN.trim();
    return await readTrimmed(TOKEN_FILE);
}

async function resolveMatrixToken(flagToken) {
    if (flagToken) return flagToken.trim();
    if (process.env.MATRIX_TOKEN) return process.env.MATRIX_TOKEN.trim();
    return await readTrimmed(MATRIX_TOKEN_FILE);
}

// ------------------------------------------------------------- http

function getJson(url, headers) {
    const u = new URL(url);
    const req = u.protocol === "http:" ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
        const r = req(
            {
                protocol: u.protocol,
                host: u.hostname,
                port: u.port || undefined,
                path: u.pathname + u.search,
                method: "GET",
                headers: { Accept: "application/json", "User-Agent": `${PLUGIN}/${VERSION}`, ...headers },
            },
            res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", c => (data += c));
                res.on("end", () => {
                    let json = null;
                    try {
                        json = data ? JSON.parse(data) : null;
                    } catch {
                        /* leave null */
                    }
                    resolve({ status: res.statusCode, json, raw: data });
                });
            }
        );
        r.on("error", reject);
        r.end();
    });
}

// ------------------------------------------------------------- mapping

/** `mxc://server/mediaId` → a plain https thumbnail URL on YOUR homeserver. */
export function mxcToThumbnail(mxc, homeserver) {
    if (typeof mxc !== "string" || !mxc.startsWith("mxc://") || !homeserver) return null;
    const rest = mxc.slice("mxc://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const server = rest.slice(0, slash);
    const mediaId = rest.slice(slash + 1).split(/[?#]/)[0];
    if (!server || !mediaId) return null;
    const u = new URL(
        `/_matrix/media/v3/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
        homeserver
    );
    u.searchParams.set("width", String(THUMB_W));
    u.searchParams.set("height", String(THUMB_H));
    u.searchParams.set("method", "crop");
    return u.href;
}

/** Build the Orbit Person for one MXID from its /profile response. */
export function toPerson(mxid, profile, homeserver, source = SOURCE, sourceId = null) {
    if (typeof mxid !== "string" || !mxid.startsWith("@") || !mxid.includes(":")) return null;
    const person = {
        source,
        sourceId: sourceId ?? mxid,
        handle: mxid, // the MXID is the handle people actually use on Matrix
        displayName: String((profile && profile.displayname) || "").trim() || mxid,
    };
    const avatar = mxcToThumbnail(profile && profile.avatar_url, homeserver);
    if (avatar) person.avatarUrl = avatar;
    return person;
}

/**
 * SPEC §2.2 mapping for Matrix presence. The Matrix enum is online / unavailable
 * / offline — there is no Matrix state that means "do not disturb", "join me" or
 * "ask me", so `busy`, `joinme` and `askme` are NEVER produced here.
 *
 *   matrix "online"      → presence(online)
 *   matrix "unavailable" → presence(online) + status(idle)   ["away" in Element]
 *   matrix "offline"     → presence(offline)
 *   status_msg (if set)  → status(text: verbatim)            [merged into the
 *                          idle status observation when both apply]
 *
 * `last_active_ago` (ms since they were last active) gives a truthful `ts`;
 * without it we fall back to now.
 */
export function mapPresence(presence, source, sourceId, now) {
    const out = [];
    if (!presence || typeof presence !== "object") return out;

    const state = String(presence.presence || "").toLowerCase();
    const ago = Number(presence.last_active_ago);
    const ts = Number.isFinite(ago) && ago >= 0 ? now - ago : now;

    let status = null;
    if (state === "online") status = "online";
    else if (state === "unavailable") status = "online"; // still connected, just away
    else if (state === "offline") status = "offline";
    else return out; // an unknown state is not mapped to a nearest-looking slot

    out.push({ source, sourceId, kind: "presence", status, ts });

    const msg = typeof presence.status_msg === "string" ? presence.status_msg.trim() : "";
    if (state === "unavailable") {
        const obs = { source, sourceId, kind: "status", status: "idle", ts };
        if (msg) obs.text = msg;
        out.push(obs);
    } else if (msg) {
        out.push({ source, sourceId, kind: "status", text: msg, ts });
    }
    return out;
}

/** The DM counterparts from the operator's own m.direct mapping. */
export function directContacts(mDirect, selfMxid) {
    if (!mDirect || typeof mDirect !== "object") return [];
    const out = [];
    for (const [mxid, rooms] of Object.entries(mDirect)) {
        if (typeof mxid !== "string" || !mxid.startsWith("@") || !mxid.includes(":")) continue;
        if (mxid === selfMxid) continue; // a note-to-self DM is not a contact
        if (!Array.isArray(rooms) || !rooms.length) continue; // stale entry, no room
        out.push(mxid);
    }
    return out.sort();
}

// --------------------------------------------------------- snapshot

async function loadSnapshot(path) {
    try {
        const s = JSON.parse(await readFile(path, "utf8"));
        if (s && typeof s === "object" && s.contacts && typeof s.contacts === "object") return s;
    } catch {
        /* no prior run */
    }
    return null;
}

async function saveSnapshot(path, snap) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(path, JSON.stringify(snap, null, 2));
}

// ------------------------------------------------------ batch build

/**
 * `entries` is [{ person, presence|null }] for the DM contacts; `selfEntry` is
 * the same shape for the reserved `self` person (whose presence is the "me" axis
 * the overlap heatmap needs, SPEC §5).
 *
 * Presence and status observations are emitted only on a CHANGE against the
 * snapshot, so running this on a timer records transitions rather than one row
 * per poll. The first run baselines whatever the current state is.
 */
export function buildBatch(entries, selfEntry, snapshot, now) {
    const observations = [];
    const nextContacts = {};
    const firstRun = snapshot === null;
    const prevContacts = snapshot ? snapshot.contacts : {};
    const persons = [];
    const seen = new Set();

    const all = selfEntry ? [{ ...selfEntry, isSelf: true }, ...entries] : entries;

    for (const { person, presence, isSelf } of all) {
        persons.push(person);
        const key = person.source + " " + person.sourceId;
        if (!isSelf) seen.add(person.sourceId);
        const prev = prevContacts[key];
        const name = person.displayName;
        const avatar = person.avatarUrl ?? "";

        if (!prev) {
            if (!firstRun && !isSelf)
                observations.push({
                    source: person.source, sourceId: person.sourceId, kind: "friend", ts: now,
                    meta: { state: "dm-opened" },
                });
        } else {
            if (name !== prev.displayName)
                observations.push({
                    source: person.source, sourceId: person.sourceId, kind: "nick",
                    text: name, ts: now, meta: { previous: prev.displayName },
                });
            if (avatar && avatar !== (prev.avatarUrl ?? ""))
                observations.push({
                    source: person.source, sourceId: person.sourceId, kind: "avatar",
                    ts: now, meta: { previous: prev.avatarUrl ?? "" },
                });
        }

        const mapped = mapPresence(presence, person.source, person.sourceId, now);
        const stateKey = presence
            ? `${String(presence.presence || "")}|${(presence.status_msg || "").trim()}`
            : null;
        if (mapped.length && stateKey !== (prev && prev.state)) observations.push(...mapped);

        nextContacts[key] = {
            displayName: name,
            avatarUrl: avatar,
            handle: person.handle,
            state: stateKey ?? (prev && prev.state),
        };
    }

    // Contacts whose DM disappeared from m.direct. Re-upsert what we knew so the
    // observation's subject is always in-batch, then drop them from the snapshot.
    for (const [key, prev] of Object.entries(prevContacts)) {
        const [src, ...idParts] = key.split(" ");
        const id = idParts.join(" ");
        if (src === "self" || seen.has(id)) continue;
        persons.push({
            source: SOURCE, sourceId: id,
            handle: prev.handle || id,
            displayName: prev.displayName || id,
        });
        observations.push({
            source: SOURCE, sourceId: id, kind: "friend", ts: now,
            meta: { state: "dm-closed" },
        });
    }

    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: now, persons, observations };
    return { batch, nextSnapshot: { version: 1, contacts: nextContacts } };
}

// ------------------------------------------------- source (live / fixture)

const PRESENCE_DISABLED = new Set([403, 404]);

async function liveSource(homeserver, matrixToken, log) {
    const base = new URL(homeserver);
    const auth = { Authorization: "Bearer " + matrixToken };
    const api = path => new URL(path, base).href;

    const who = await getJson(api("/_matrix/client/v3/account/whoami"), auth);
    if (who.status === 401)
        throw new Error("401 from whoami — the Matrix access token is wrong, expired, or was invalidated by a logout.");
    if (who.status !== 200 || !who.json || !who.json.user_id)
        throw new Error(`whoami returned ${who.status}: ${String(who.raw).slice(0, 200)}`);
    const selfMxid = who.json.user_id;

    // The operator's OWN direct-message mapping. 404 simply means "no DMs yet".
    let mDirect = {};
    const dm = await getJson(
        api(`/_matrix/client/v3/user/${encodeURIComponent(selfMxid)}/account_data/m.direct`),
        auth
    );
    if (dm.status === 200 && dm.json) mDirect = dm.json;
    else if (dm.status === 404) log("note: no m.direct account data — you have no direct-message rooms yet.");
    else log(`warning: m.direct returned ${dm.status}; continuing with an empty contact list.`);

    const contacts = directContacts(mDirect, selfMxid);
    log(`found ${contacts.length} direct-message contact(s) in m.direct`);

    const profiles = {};
    const presence = {};
    let presenceDisabled = 0;
    let presenceTried = 0;

    for (const mxid of [selfMxid, ...contacts]) {
        const p = await getJson(api(`/_matrix/client/v3/profile/${encodeURIComponent(mxid)}`), auth);
        profiles[mxid] = p.status === 200 && p.json ? p.json : {};
        if (p.status !== 200 && p.status !== 404) log(`note: profile for ${mxid} returned ${p.status}`);

        presenceTried++;
        const pr = await getJson(api(`/_matrix/client/v3/presence/${encodeURIComponent(mxid)}/status`), auth);
        if (pr.status === 200 && pr.json) presence[mxid] = pr.json;
        else if (PRESENCE_DISABLED.has(pr.status)) presenceDisabled++;
        else log(`note: presence for ${mxid} returned ${pr.status}`);
    }

    if (presenceDisabled === presenceTried && presenceTried > 0)
        log(
            "note: this homeserver does not serve presence (every /presence call was refused). " +
            "That is a common server setting, not a failure — emitting the roster without presence."
        );
    else if (presenceDisabled)
        log(`note: presence unavailable for ${presenceDisabled} of ${presenceTried} user(s); they get no presence observation.`);

    return { selfMxid, contacts, profiles, presence };
}

async function readFixture(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    } catch (e) {
        throw new Error(`could not read fixture "${path}": ${e.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`fixture "${path}" is not valid JSON: ${e.message}`);
    }
}

async function fixtureSource(path, log) {
    const fx = await readFixture(path);
    const selfMxid = fx.whoami && fx.whoami.user_id;
    if (!selfMxid) throw new Error(`fixture "${path}" has no whoami.user_id`);

    const contacts = directContacts(fx["m.direct"], selfMxid);
    log(`found ${contacts.length} direct-message contact(s) in m.direct`);

    const profiles = fx.profiles || {};
    const rawPresence = fx.presence || {};
    const presence = {};
    let presenceDisabled = 0;
    let presenceTried = 0;

    // A fixture presence entry with `_status` models a homeserver refusing the
    // call (403 M_FORBIDDEN / 404), which is how presence-disabled servers behave.
    for (const mxid of [selfMxid, ...contacts]) {
        presenceTried++;
        const entry = rawPresence[mxid];
        const status = entry && entry._status ? Number(entry._status) : 200;
        if (status === 200 && entry) presence[mxid] = entry;
        else if (PRESENCE_DISABLED.has(status)) presenceDisabled++;
    }
    if (presenceDisabled === presenceTried && presenceTried > 0)
        log("note: this homeserver does not serve presence (every /presence call was refused).");
    else if (presenceDisabled)
        log(`note: presence unavailable for ${presenceDisabled} of ${presenceTried} user(s); they get no presence observation.`);

    return { selfMxid, contacts, profiles, presence };
}

// ------------------------------------------------------------ POST

function postBatch(port, token, batch) {
    const body = Buffer.from(JSON.stringify(batch));
    return new Promise((resolve, reject) => {
        const req = httpRequest(
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

    const log = m => console.error(m);
    const homeserver = opts.homeserver || process.env.MATRIX_HOMESERVER || null;

    let selfMxid, contacts, profiles, presence;
    try {
        if (opts.fixture) {
            log(`[fixture] reading canned API responses from ${opts.fixture} (no network)`);
            ({ selfMxid, contacts, profiles, presence } = await fixtureSource(opts.fixture, log));
        } else {
            if (!homeserver) {
                console.error("error: no homeserver. Pass --homeserver https://matrix.org or set $MATRIX_HOMESERVER.");
                return 1;
            }
            const matrixToken = await resolveMatrixToken(opts.matrixToken);
            if (!matrixToken) {
                console.error(
                    "error: no Matrix access token. Pass --matrix-token, set $MATRIX_TOKEN, or write it to " +
                    MATRIX_TOKEN_FILE + " (Element: Settings -> Help & About -> Access Token). " +
                    "Prefer the file: an access token is as powerful as your password and shell history is forever."
                );
                return 1;
            }
            ({ selfMxid, contacts, profiles, presence } = await liveSource(homeserver, matrixToken, log));
        }
    } catch (e) {
        if (e.code === "ENOTFOUND") console.error(`error: could not resolve the homeserver host (${e.hostname}).`);
        else if (e.code === "ECONNREFUSED") console.error("error: connection refused by the homeserver.");
        else console.error(`error: ${e.message}`);
        return 1;
    }

    const hsBase = homeserver || guessHomeserver(selfMxid);
    const now = Date.now();

    // The reserved operator identity (SPEC §2.1). Matrix CAN see your own
    // presence, so `self` gets real presence observations — this is the "me"
    // axis the overlap heatmap needs.
    const selfPerson = toPerson(selfMxid, profiles[selfMxid], hsBase, "self", "me");
    const selfEntry = selfPerson ? { person: selfPerson, presence: presence[selfMxid] || null } : null;

    const entries = [];
    for (const mxid of contacts) {
        const person = toPerson(mxid, profiles[mxid], hsBase);
        if (!person) continue;
        entries.push({ person, presence: presence[mxid] || null });
    }

    const snapPath = snapshotFile(Boolean(opts.fixture));
    const snapshot = await loadSnapshot(snapPath);
    const { batch, nextSnapshot } = buildBatch(entries, selfEntry, snapshot, now);
    const nPresence = batch.observations.filter(o => o.kind === "presence").length;

    if (opts.dryRun) {
        console.log(JSON.stringify(batch, null, 2));
        console.error(
            `\n[dry-run] ${batch.persons.length} persons, ${batch.observations.length} observations ` +
            `(${nPresence} presence). Not POSTing, snapshot untouched.`
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
        if (e.code === "ECONNREFUSED")
            console.error(`error: connection refused at 127.0.0.1:${opts.port} — is NX Orbit running?`);
        else console.error(`error: POST failed: ${e.message}`);
        return 1;
    }

    if (res.status === 200) {
        await saveSnapshot(snapPath, nextSnapshot); // only advance on an accepted batch
        console.log(`ok: ${res.body || "{}"}  (${batch.persons.length} persons, ${batch.observations.length} observations)`);
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

/** Fixture mode without --homeserver: derive a display base from the MXID domain. */
function guessHomeserver(mxid) {
    const colon = typeof mxid === "string" ? mxid.indexOf(":") : -1;
    return colon > 0 ? `https://${mxid.slice(colon + 1)}` : null;
}

// Only run as a CLI; importing this file (tests) must not execute main().
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("fatal:", e);
        process.exit(1);
    });
}
