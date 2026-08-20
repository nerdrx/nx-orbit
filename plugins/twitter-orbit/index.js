#!/usr/bin/env node
/*
 * twitter-orbit — NX Orbit external emitter for X / Twitter.
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 nerdrx
 *
 * A standalone Node CLI (ES modules, zero dependencies). You run it while it
 * has access to YOUR OWN following list — the accounts *you follow*, exported
 * from your own X data or fetched with your own API token. It parses that list
 * into Orbit `Person` upserts + `bio`/`nick` change `Observation`s and POSTs a
 * single batch (SPEC §3) to the loopback ingest endpoint.
 *
 * Charter compliance (SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: it ONLY reads a following list that YOU own
 *     (your data export or your token's GET /users/:id/following). It never
 *     scrapes, searches, crawls the firehose, or touches a non-followed account.
 *   - Surface-only: name / @handle / bio / avatar — exactly the profile fields
 *     X renders on the account's public card to you as a logged-in follower.
 *   - Observations, not conclusions: it emits `bio`/`nick` change events with
 *     real timestamps. No scores, no sentiment, no inference.
 *   - Local delivery only: POSTs to 127.0.0.1 with a bearer token. No phone-home.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PLUGIN = "twitter-orbit";
const VERSION = "1.0.0";
const SOURCE = "twitter";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = { port: 8477, token: null, following: "following.json", dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") o.dryRun = true;
        else if (a === "--help" || a === "-h") o.help = true;
        else if (a === "--port") o.port = Number(argv[++i]);
        else if (a === "--token") o.token = argv[++i];
        else if (a === "--following") o.following = argv[++i];
        else if (a.startsWith("--port=")) o.port = Number(a.slice(7));
        else if (a.startsWith("--token=")) o.token = a.slice(8);
        else if (a.startsWith("--following=")) o.following = a.slice(12);
        else { console.error(`unknown argument: ${a}`); o.help = true; }
    }
    return o;
}

const HELP = `twitter-orbit ${VERSION} — NX Orbit emitter for accounts YOU follow on X.

Usage:
  node index.js --following <file> [--dry-run] [--port N] [--token TOKEN]

Options:
  --following <file>  Your following list (default: following.json). Must be YOUR
                      own data: an X data export, or the JSON body of your token's
                      GET /2/users/:id/following. Accepted shapes:
                        - API v2:   { "data": [ { id, username, name, description, profile_image_url } ] }
                        - API v1.1: { "users": [ { id_str, screen_name, name, description, profile_image_url_https } ] }
                        - a plain array of either of the above objects
  --dry-run           Print the batch JSON to stdout instead of POSTing it.
                      Does not read or write the snapshot, so it is repeatable.
  --port N            Loopback ingest port (default 8477).
  --token TOKEN       Orbit ingest bearer token. Resolution order:
                        --token  >  $NX_ORBIT_TOKEN  >  ~/.config/nx-orbit/ingest.token

This tool ONLY ingests accounts you follow, from your own data/token. It never
scrapes strangers or touches accounts you do not follow.`;

// -------------------------------------------------------------- config

const CONFIG_DIR = join(homedir(), ".config", "nx-orbit");
const TOKEN_FILE = join(CONFIG_DIR, "ingest.token");
const SNAPSHOT_FILE = join(CONFIG_DIR, "twitter-orbit.snapshot.json");

async function resolveToken(flagToken) {
    if (flagToken) return flagToken.trim();
    if (process.env.NX_ORBIT_TOKEN) return process.env.NX_ORBIT_TOKEN.trim();
    try {
        return (await readFile(TOKEN_FILE, "utf8")).trim();
    } catch {
        return null;
    }
}

// -------------------------------------------------- following parsing

/** Normalise any accepted export shape into a flat array of raw account objects. */
function extractAccounts(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;   // API v2
    if (parsed && Array.isArray(parsed.users)) return parsed.users; // API v1.1
    throw new Error("could not find an account array (expected top-level array, or a `data`/`users` array)");
}

/** Map one raw X account object to an Orbit Person (only first-person profile fields). */
function toPerson(raw) {
    const id = String(raw.id ?? raw.id_str ?? "").trim();
    const screen = (raw.username ?? raw.screen_name ?? "").trim();
    if (!id || !screen) return null; // skip malformed rows rather than invent data

    const person = {
        source: SOURCE,
        sourceId: id,
        handle: "@" + screen.replace(/^@/, ""),
        displayName: (raw.name ?? screen).trim(),
    };
    const bio = (raw.description ?? "").trim();
    if (bio) person.bio = bio; // verbatim; omit when empty (never a placeholder)
    const avatar = raw.profile_image_url ?? raw.profile_image_url_https;
    if (avatar) person.avatarUrl = String(avatar);
    return person;
}

// --------------------------------------------------------- snapshot

async function loadSnapshot() {
    try {
        return JSON.parse(await readFile(SNAPSHOT_FILE, "utf8"));
    } catch {
        return {}; // no prior run
    }
}

async function saveSnapshot(snap) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
}

// ------------------------------------------------------ batch build

/**
 * Build the batch. Persons are always upserted (idempotent). Observations are
 * emitted only for a NEW followed account's bio, or a CHANGED bio/name vs the
 * snapshot — so re-running with the snapshot intact emits nothing new.
 */
function buildBatch(persons, snapshot, now) {
    const observations = [];
    const nextSnapshot = {};

    for (const p of persons) {
        const prev = snapshot[p.sourceId];
        const bio = p.bio ?? "";
        const name = p.displayName;

        if (!prev) {
            // First time we see this followed account: baseline its current bio.
            if (bio) observations.push({ source: SOURCE, sourceId: p.sourceId, kind: "bio", text: bio, ts: now });
        } else {
            if (name !== prev.name) {
                observations.push({
                    source: SOURCE, sourceId: p.sourceId, kind: "nick",
                    text: name, ts: now, meta: { previous: prev.name },
                });
            }
            if (bio !== (prev.bio ?? "") && bio) {
                observations.push({
                    source: SOURCE, sourceId: p.sourceId, kind: "bio",
                    text: bio, ts: now, meta: { previous: prev.bio ?? "" },
                });
            }
        }
        nextSnapshot[p.sourceId] = { name, bio };
    }

    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: now, persons, observations };
    return { batch, nextSnapshot };
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

    // Parse the following list.
    let raw;
    try {
        raw = JSON.parse(await readFile(opts.following, "utf8"));
    } catch (e) {
        console.error(`error: could not read following file "${opts.following}": ${e.message}`);
        return 1;
    }

    let accounts;
    try {
        accounts = extractAccounts(raw);
    } catch (e) {
        console.error(`error: ${e.message}`);
        return 1;
    }

    const persons = accounts.map(toPerson).filter(Boolean);
    if (!persons.length) {
        console.error("error: no valid followed accounts found in the following list.");
        return 1;
    }

    // A dry run neither reads nor writes the snapshot, so it always shows the
    // full baseline and is repeatable. (Reading it would make a dry run after a
    // real run print an empty batch — technically "what would be sent", but
    // useless for inspecting what this plugin actually emits.)
    const snapshot = opts.dryRun ? {} : await loadSnapshot();
    const now = Date.now();
    const { batch, nextSnapshot } = buildBatch(persons, snapshot, now);

    if (opts.dryRun) {
        console.log(JSON.stringify(batch, null, 2));
        console.error(
            `\n[dry-run] ${batch.persons.length} persons, ${batch.observations.length} observations. ` +
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
        if (e.code === "ECONNREFUSED") {
            console.error(`error: connection refused at 127.0.0.1:${opts.port} — is NX Orbit running?`);
        } else {
            console.error(`error: POST failed: ${e.message}`);
        }
        return 1;
    }

    if (res.status === 200) {
        await saveSnapshot(nextSnapshot); // only advance snapshot on accepted batch
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

main().then(code => process.exit(code)).catch(e => {
    console.error("fatal:", e);
    process.exit(1);
});
