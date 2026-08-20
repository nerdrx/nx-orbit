#!/usr/bin/env node
/*
 * lastfm-orbit — NX Orbit external emitter for Last.fm.
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 nerdrx
 *
 * A standalone Node CLI (ES modules, zero dependencies). It uses the official
 * Last.fm API with YOUR OWN API key, reads YOUR OWN friends list, and turns the
 * thing each friend is *publicly broadcasting right now* — their now-playing
 * track — into an Orbit `status` observation. It POSTs one batch (SPEC §3) to
 * the loopback ingest endpoint.
 *
 * Charter compliance (SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: the roster comes from user.getFriends for YOUR
 *     username — the people you added as friends on Last.fm. It never touches
 *     the charts, tag pages, "similar users", or any account you did not friend.
 *   - Surface-only: name, realname, avatar and the now-playing / most-recent
 *     track — exactly what last.fm/user/<them> renders to anyone they show it to.
 *   - Observations, not conclusions: the track text is passed through verbatim.
 *     There is NO taste analysis, NO ranking, NO "top artists", NO similarity
 *     score, NO listening-habit profile. Orbit is not a recommender.
 *   - No faked presence: "was listening" is NOT "is online". Scrobbles never
 *     become `presence` observations (that would be exactly the inference §0.3
 *     forbids). This plugin emits ZERO presence, ever.
 *   - Local delivery only: POSTs to 127.0.0.1 with a bearer token. No phone-home.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PLUGIN = "lastfm-orbit";
const VERSION = "1.0.0";
const SOURCE = "lastfm";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
// Last.fm's terms ask for no more than ~5 requests/second averaged over 5
// minutes. 250 ms between per-friend calls keeps us at 4/s with margin.
const DEFAULT_DELAY_MS = 250;
const FRIENDS_PER_PAGE = 50;
const MAX_PAGES = 100; // hard stop against a runaway paging loop

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = {
        port: 8477,
        token: null,
        apiKey: null,
        user: null,
        maxFriends: 0, // 0 = no limit
        delayMs: DEFAULT_DELAY_MS,
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
        else if (a === "--api-key") o.apiKey = argv[++i];
        else if (a === "--user") o.user = argv[++i];
        else if (a === "--max-friends") o.maxFriends = Number(argv[++i]);
        else if (a === "--delay-ms") o.delayMs = Number(argv[++i]);
        else if (a === "--from-fixture") o.fixture = argv[++i];
        else if (eat(a, "--port", "port", Number)) ;
        else if (eat(a, "--token", "token")) ;
        else if (eat(a, "--api-key", "apiKey")) ;
        else if (eat(a, "--user", "user")) ;
        else if (eat(a, "--max-friends", "maxFriends", Number)) ;
        else if (eat(a, "--delay-ms", "delayMs", Number)) ;
        else if (eat(a, "--from-fixture", "fixture")) ;
        else { console.error(`unknown argument: ${a}`); o.help = true; }
    }
    return o;
}

const HELP = `lastfm-orbit ${VERSION} — NX Orbit emitter for YOUR Last.fm friends and what they're playing.

Usage:
  node index.js --user yourname [--api-key KEY] [--dry-run] [--port N] [--token TOKEN]
  node index.js --from-fixture fixture.sample.json --dry-run

Options:
  --user NAME          Your own Last.fm username (or $LASTFM_USER). Its friends
                       list is the roster; nobody else's is ever read.
  --api-key KEY        Your own Last.fm API key (or $LASTFM_API_KEY, or
                       ~/.config/nx-orbit/lastfm.key). Get one at
                       https://www.last.fm/api/account/create
  --max-friends N      Only look up the first N friends' recent track (default:
                       all of them). Useful for a large friends list.
  --delay-ms N         Delay between per-friend API calls (default ${DEFAULT_DELAY_MS} ms ≈ 4 req/s;
                       Last.fm asks for at most ~5 req/s).
  --from-fixture FILE  Read canned API responses from FILE instead of the
                       network. For offline testing of the mapping logic.
  --dry-run            Print the batch JSON to stdout instead of POSTing it.
                       Does not read or write the snapshot, so it is repeatable.
  --port N             Loopback ingest port (default 8477).
  --token TOKEN        Orbit ingest bearer token. Resolution order:
                         --token  >  $NX_ORBIT_TOKEN  >  ~/.config/nx-orbit/ingest.token

A now-playing track becomes a "status" observation ("♪ Artist — Track"), verbatim.
It NEVER becomes a "presence" observation: "was listening" is not "is online",
and inferring one from the other is exactly what SPEC §0.3 forbids.`;

// -------------------------------------------------------------- config

const CONFIG_DIR = join(homedir(), ".config", "nx-orbit");
const TOKEN_FILE = join(CONFIG_DIR, "ingest.token");
const LASTFM_KEY_FILE = join(CONFIG_DIR, "lastfm.key");

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

async function resolveApiKey(flagKey) {
    if (flagKey) return flagKey.trim();
    if (process.env.LASTFM_API_KEY) return process.env.LASTFM_API_KEY.trim();
    return await readTrimmed(LASTFM_KEY_FILE);
}

// ------------------------------------------------------------- http

function getJson(url) {
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
                headers: { Accept: "application/json", "User-Agent": `${PLUGIN}/${VERSION}` },
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

function apiUrl(apiKey, method, params) {
    const u = new URL(API_ROOT);
    u.searchParams.set("method", method);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    u.searchParams.set("api_key", apiKey);
    u.searchParams.set("format", "json");
    return u.href;
}

async function callApi(apiKey, method, params) {
    const res = await getJson(apiUrl(apiKey, method, params));
    if (res.json && res.json.error) {
        const e = new Error(`Last.fm ${method} error ${res.json.error}: ${res.json.message}`);
        e.lastfmError = res.json.error;
        throw e;
    }
    if (res.status !== 200) throw new Error(`Last.fm ${method} returned HTTP ${res.status}: ${String(res.raw).slice(0, 200)}`);
    return res.json;
}

// ---------------------------------------------------------- shape helpers

/** Last.fm collapses a single-element list into a bare object. Normalise. */
export function asArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

const IMAGE_ORDER = ["mega", "extralarge", "large", "medium", "small"];

/** Pick the largest non-empty image URL from a Last.fm `image` array. */
export function largestImage(images) {
    const list = asArray(images);
    for (const size of IMAGE_ORDER) {
        const hit = list.find(i => i && i.size === size && i["#text"]);
        if (hit) return String(hit["#text"]);
    }
    const any = list.filter(i => i && i["#text"]).pop();
    return any ? String(any["#text"]) : null;
}

// ------------------------------------------------------------- mapping

/** Map one raw Last.fm user object to an Orbit Person (allow-listed fields only). */
export function toPerson(raw, source = SOURCE, sourceId = null) {
    if (!raw || !raw.name) return null;
    const name = String(raw.name).trim();
    if (!name) return null;

    const person = {
        source,
        sourceId: sourceId ?? name,
        handle: name,
        displayName: String(raw.realname || "").trim() || name,
    };
    const img = largestImage(raw.image);
    if (img) person.avatarUrl = img;
    return person;
}

/**
 * Turn the single most recent track of a user into a `status` observation, or
 * null when there is nothing to say.
 *
 *   nowplaying → they are broadcasting it RIGHT NOW → ts = now
 *   date.uts   → a public scrobble they published   → ts = that scrobble's time
 *
 * The text is "♪ Artist — Track", verbatim from the API. There is no analysis,
 * no genre, no rating and no ranking, and it is NEVER a presence observation.
 */
export function toStatusObservation(recentTracks, source, sourceId, now) {
    const track = asArray(recentTracks && recentTracks.recenttracks && recentTracks.recenttracks.track)[0];
    if (!track || !track.name) return null;

    const artist = String((track.artist && (track.artist["#text"] ?? track.artist.name)) || "").trim();
    const title = String(track.name).trim();
    if (!title) return null;
    const text = "♪ " + (artist ? `${artist} — ${title}` : title);

    const nowPlaying = track["@attr"] && String(track["@attr"].nowplaying) === "true";
    if (nowPlaying) return { source, sourceId, kind: "status", text, ts: now, _key: "np:" + text };

    const uts = track.date && Number(track.date.uts);
    if (Number.isFinite(uts) && uts > 0) {
        const ts = uts * 1000;
        return { source, sourceId, kind: "status", text, ts, _key: `sc:${ts}:${text}` };
    }
    return null; // no timestamp we can honestly attach → emit nothing
}

// --------------------------------------------------------- snapshot

async function loadSnapshot(path) {
    try {
        const s = JSON.parse(await readFile(path, "utf8"));
        if (s && typeof s === "object" && s.friends && typeof s.friends === "object") return s;
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
 * `entries` is [{ person, statusObs|null }] for the operator's friends;
 * `selfEntry` is the same shape for the reserved `self` person.
 *
 * Persons are always upserted. Observations come from a snapshot diff:
 *   realname changed → nick   (meta.previous)
 *   avatar changed   → avatar (meta.previous)
 *   new friend       → friend (meta.state "friended"), except on the first run
 *   gone friend      → friend (meta.state "unfriended")
 *   new track        → status (only when it differs from what we last emitted)
 *
 * NO `presence` observation is produced by any path in this function.
 */
export function buildBatch(entries, selfEntry, snapshot, now) {
    const observations = [];
    const nextFriends = {};
    const firstRun = snapshot === null;
    const prevFriends = snapshot ? snapshot.friends : {};
    const persons = [];
    const seen = new Set();

    if (selfEntry) {
        persons.push(selfEntry.person);
        const prevKey = snapshot ? snapshot.selfTrack : undefined;
        if (selfEntry.statusObs && selfEntry.statusObs._key !== prevKey) {
            const { _key, ...obs } = selfEntry.statusObs;
            observations.push(obs);
        }
    }

    for (const { person, statusObs } of entries) {
        persons.push(person);
        seen.add(person.sourceId);
        const prev = prevFriends[person.sourceId];
        const name = person.displayName;
        const avatar = person.avatarUrl ?? "";

        if (!prev) {
            if (!firstRun)
                observations.push({
                    source: SOURCE, sourceId: person.sourceId, kind: "friend", ts: now,
                    meta: { state: "friended" },
                });
        } else {
            if (name !== prev.displayName)
                observations.push({
                    source: SOURCE, sourceId: person.sourceId, kind: "nick",
                    text: name, ts: now, meta: { previous: prev.displayName },
                });
            if (avatar && avatar !== (prev.avatarUrl ?? ""))
                observations.push({
                    source: SOURCE, sourceId: person.sourceId, kind: "avatar",
                    ts: now, meta: { previous: prev.avatarUrl ?? "" },
                });
        }

        if (statusObs && statusObs._key !== (prev && prev.track)) {
            const { _key, ...obs } = statusObs;
            observations.push(obs);
        }

        nextFriends[person.sourceId] = {
            displayName: name,
            avatarUrl: avatar,
            handle: person.handle,
            track: statusObs ? statusObs._key : prev && prev.track,
        };
    }

    // Friends that vanished from the list. Re-upsert what we already knew so the
    // observation's subject is always in-batch, then drop them from the snapshot.
    for (const [id, prev] of Object.entries(prevFriends)) {
        if (seen.has(id)) continue;
        persons.push({
            source: SOURCE, sourceId: id,
            handle: prev.handle || id,
            displayName: prev.displayName || id,
        });
        observations.push({
            source: SOURCE, sourceId: id, kind: "friend", ts: now,
            meta: { state: "unfriended" },
        });
    }

    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: now, persons, observations };
    const nextSnapshot = {
        version: 1,
        friends: nextFriends,
        selfTrack: selfEntry && selfEntry.statusObs ? selfEntry.statusObs._key : snapshot && snapshot.selfTrack,
    };
    return { batch, nextSnapshot };
}

// ------------------------------------------------- source (live / fixture)

async function liveSource(apiKey, user, opts, log) {
    // 1. The operator's own profile → the reserved `self` person.
    const info = await callApi(apiKey, "user.getInfo", { user });
    const selfRaw = info && info.user;
    if (!selfRaw) throw new Error("user.getInfo returned no user object");

    // 2. The operator's own friends list, paginated.
    const friends = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        let res;
        try {
            res = await callApi(apiKey, "user.getFriends", { user, limit: FRIENDS_PER_PAGE, page });
        } catch (e) {
            if (e.lastfmError === 6) break; // "no such page" / user has no friends
            throw e;
        }
        const block = res && res.friends;
        const users = asArray(block && block.user);
        friends.push(...users);
        const total = Number(block && block["@attr"] && block["@attr"].totalPages) || 1;
        log(`  … friends page ${page}/${total} (${friends.length} so far)`);
        if (page >= total || !users.length) break;
        await sleep(opts.delayMs);
    }

    const limited = opts.maxFriends > 0 ? friends.slice(0, opts.maxFriends) : friends;
    if (limited.length < friends.length)
        log(`note: --max-friends ${opts.maxFriends} — only the first ${limited.length} of ${friends.length} friends get a track lookup.`);

    // 3. One recent-track call per friend, rate-limited, plus one for yourself.
    const recent = {};
    for (const f of [selfRaw, ...limited]) {
        if (!f || !f.name || recent[f.name] !== undefined) continue;
        await sleep(opts.delayMs);
        try {
            recent[f.name] = await callApi(apiKey, "user.getRecentTracks", { user: f.name, limit: 1 });
        } catch (e) {
            // A private/blocked recent-tracks feed is normal. Skip that friend's
            // status, keep their person row, keep going.
            log(`note: no recent tracks for ${f.name} (${e.message})`);
            recent[f.name] = null;
        }
    }

    return { self: selfRaw, friends: limited, recent, totalFriends: friends.length };
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

async function fixtureSource(path, opts, log) {
    const fx = await readFixture(path);
    const selfRaw = fx["user.getInfo"] && fx["user.getInfo"].user;
    if (!selfRaw) throw new Error(`fixture "${path}" has no ["user.getInfo"].user`);

    // Pages are walked exactly as the live client walks them, so the paging
    // logic and the single-object-vs-array normalisation are really exercised.
    const pages = fx["user.getFriends"];
    const friends = [];
    for (const page of asArray(pages)) {
        const block = page && page.friends;
        const users = asArray(block && block.user);
        friends.push(...users);
        log(`  … fixture friends page: ${users.length} users`);
    }
    const limited = opts.maxFriends > 0 ? friends.slice(0, opts.maxFriends) : friends;

    const recent = fx["user.getRecentTracks"] || {};
    return { self: selfRaw, friends: limited, recent, totalFriends: friends.length };
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
    if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) opts.delayMs = DEFAULT_DELAY_MS;

    const log = m => console.error(m);
    const user = opts.user || process.env.LASTFM_USER || null;

    let self, friends, recent, totalFriends;
    try {
        if (opts.fixture) {
            log(`[fixture] reading canned API responses from ${opts.fixture} (no network)`);
            ({ self, friends, recent, totalFriends } = await fixtureSource(opts.fixture, opts, log));
        } else {
            if (!user) {
                console.error("error: no username. Pass --user <your last.fm username> or set $LASTFM_USER.");
                return 1;
            }
            const apiKey = await resolveApiKey(opts.apiKey);
            if (!apiKey) {
                console.error(
                    "error: no Last.fm API key. Pass --api-key, set $LASTFM_API_KEY, or write it to " +
                    LASTFM_KEY_FILE + " (create one at https://www.last.fm/api/account/create)."
                );
                return 1;
            }
            ({ self, friends, recent, totalFriends } = await liveSource(apiKey, user, opts, log));
        }
    } catch (e) {
        if (e.code === "ENOTFOUND") console.error("error: could not resolve ws.audioscrobbler.com — no network?");
        else if (e.code === "ECONNREFUSED") console.error("error: connection refused by the Last.fm API.");
        else console.error(`error: ${e.message}`);
        return 1;
    }

    const now = Date.now();

    // The reserved operator identity (SPEC §2.1). You can be listening too — but
    // even for yourself this plugin emits no presence, only a status.
    const selfPerson = toPerson(self, "self", "me");
    const selfEntry = selfPerson
        ? { person: selfPerson, statusObs: toStatusObservation(recent[self.name], "self", "me", now) }
        : null;

    const entries = [];
    for (const f of friends) {
        const person = toPerson(f);
        if (!person) continue;
        entries.push({ person, statusObs: toStatusObservation(recent[person.sourceId], SOURCE, person.sourceId, now) });
    }

    const snapPath = snapshotFile(Boolean(opts.fixture));
    const snapshot = await loadSnapshot(snapPath);
    const { batch, nextSnapshot } = buildBatch(entries, selfEntry, snapshot, now);
    const nowPlaying = entries.filter(e => e.statusObs && e.statusObs._key.startsWith("np:")).length;

    if (opts.dryRun) {
        console.log(JSON.stringify(batch, null, 2));
        console.error(
            `\n[dry-run] ${batch.persons.length} persons, ${batch.observations.length} observations ` +
            `(${nowPlaying} of ${totalFriends} friends now playing; 0 presence — scrobbles are not presence). ` +
            `Not POSTing, snapshot untouched.`
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

// Only run as a CLI; importing this file (tests) must not execute main().
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("fatal:", e);
        process.exit(1);
    });
}
