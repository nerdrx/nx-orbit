#!/usr/bin/env node
/*
 * mastodon-orbit — NX Orbit external emitter for Mastodon (and compatible).
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 nerdrx
 *
 * A standalone Node CLI (ES modules, zero dependencies). It talks to YOUR OWN
 * instance with YOUR OWN access token, reads the accounts *you follow*, and
 * POSTs a single batch (SPEC §3) of `Person` upserts + bio/nick/avatar/friend
 * change `Observation`s to the loopback ingest endpoint.
 *
 * Charter compliance (SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: the ONLY account-listing endpoint it calls is
 *     GET /api/v1/accounts/:me/following — the accounts you chose to follow,
 *     as your own logged-in self. It never reads the public/local/federated
 *     timeline, never calls search, never fetches a non-followed account, and
 *     never walks anybody else's social graph.
 *   - Surface-only: display name, @acct, note (bio), avatar and the profile
 *     metadata `fields` — exactly the profile card the instance renders to you.
 *   - Observations, not conclusions: bio/nick/avatar/friend change events with
 *     real timestamps. No scores, no sentiment, no inference. Mastodon has no
 *     presence, so this plugin emits NO `presence` observations at all.
 *   - Local delivery only: POSTs to 127.0.0.1 with a bearer token. No phone-home.
 *   - Verbatim: `note` is HTML-stripped to plain text and otherwise untouched.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN = "mastodon-orbit";
const VERSION = "1.0.0";
const SOURCE = "mastodon";

const MAX_PAGES = 200; // hard stop; a malformed Link header must not loop forever

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = {
        port: 8477,
        token: null,
        instance: null,
        mastodonToken: null,
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
        else if (a === "--instance") o.instance = argv[++i];
        else if (a === "--mastodon-token") o.mastodonToken = argv[++i];
        else if (a === "--from-fixture") o.fixture = argv[++i];
        else if (eat(a, "--port", "port", Number)) ;
        else if (eat(a, "--token", "token")) ;
        else if (eat(a, "--instance", "instance")) ;
        else if (eat(a, "--mastodon-token", "mastodonToken")) ;
        else if (eat(a, "--from-fixture", "fixture")) ;
        else { console.error(`unknown argument: ${a}`); o.help = true; }
    }
    return o;
}

const HELP = `mastodon-orbit ${VERSION} — NX Orbit emitter for the accounts YOU follow on Mastodon.

Usage:
  node index.js --instance https://mastodon.social [--dry-run] [--port N] [--token TOKEN]
  node index.js --from-fixture fixture.sample.json --dry-run

Options:
  --instance URL        Your own Mastodon instance (or $MASTODON_INSTANCE).
  --mastodon-token TOK  Your own access token (or $MASTODON_TOKEN, or
                        ~/.config/nx-orbit/mastodon.token). Scopes needed:
                        read:accounts read:follows — nothing else.
  --from-fixture FILE   Read canned API responses from FILE instead of the
                        network. For offline testing of the mapping logic.
  --dry-run             Print the batch JSON to stdout instead of POSTing it.
                        Does not read or write the snapshot, so it is repeatable.
  --port N              Loopback ingest port (default 8477).
  --token TOKEN         Orbit ingest bearer token. Resolution order:
                          --token  >  $NX_ORBIT_TOKEN  >  ~/.config/nx-orbit/ingest.token

It calls exactly two endpoints: /api/v1/accounts/verify_credentials (who you are)
and /api/v1/accounts/:you/following (who you follow). No timeline, no search, no
non-followed account. Mastodon publishes no presence, so no presence is emitted.`;

// -------------------------------------------------------------- config

const CONFIG_DIR = join(homedir(), ".config", "nx-orbit");
const TOKEN_FILE = join(CONFIG_DIR, "ingest.token");
const MASTODON_TOKEN_FILE = join(CONFIG_DIR, "mastodon.token");

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

async function resolveMastodonToken(flagToken) {
    if (flagToken) return flagToken.trim();
    if (process.env.MASTODON_TOKEN) return process.env.MASTODON_TOKEN.trim();
    return await readTrimmed(MASTODON_TOKEN_FILE);
}

// ------------------------------------------------------------- http

/** GET a JSON document. Resolves { status, headers, json }. Throws on transport error. */
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
                        /* leave null; caller reports the status */
                    }
                    resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
                });
            }
        );
        r.on("error", reject);
        r.end();
    });
}

/**
 * Parse a `Link:` header and return the rel="next" URL, or null.
 * Mastodon sends e.g.
 *   <https://host/api/v1/accounts/1/following?max_id=110>; rel="next", <…>; rel="prev"
 */
export function parseLinkNext(linkHeader) {
    if (!linkHeader) return null;
    const header = Array.isArray(linkHeader) ? linkHeader.join(", ") : String(linkHeader);
    for (const part of header.split(/,\s*(?=<)/)) {
        const m = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
        if (!m) continue;
        if (/\brel\s*=\s*"?next"?/i.test(m[2])) return m[1];
    }
    return null;
}

// ------------------------------------------------- source (live / fixture)

/**
 * A "source" yields { self, following[] }. Two implementations: the live API and
 * a fixture file. Both produce the same raw Mastodon account objects, so the
 * mapping below is exercised identically online and offline.
 */
async function liveSource(instance, mastodonToken, log) {
    const base = new URL(instance);
    const auth = { Authorization: "Bearer " + mastodonToken };

    const me = await getJson(new URL("/api/v1/accounts/verify_credentials", base).href, auth);
    if (me.status === 401) throw new Error("401 from verify_credentials — the Mastodon access token is wrong or revoked.");
    if (me.status === 403)
        throw new Error("403 from verify_credentials — the token lacks the read:accounts scope.");
    if (me.status !== 200 || !me.json || !me.json.id)
        throw new Error(`verify_credentials returned ${me.status}: ${String(me.raw).slice(0, 200)}`);

    const self = me.json;
    const following = [];
    let url = new URL(`/api/v1/accounts/${encodeURIComponent(self.id)}/following?limit=80`, base).href;

    for (let page = 0; url && page < MAX_PAGES; page++) {
        const res = await getJson(url, auth);
        if (res.status === 403) throw new Error("403 from /following — the token lacks the read:follows scope.");
        if (res.status !== 200 || !Array.isArray(res.json))
            throw new Error(`/following page ${page + 1} returned ${res.status}: ${String(res.raw).slice(0, 200)}`);
        following.push(...res.json);

        const next = parseLinkNext(res.headers.link);
        if (!next) {
            url = null;
            break;
        }
        // Only ever follow a `next` that stays on YOUR instance — a Link header is
        // remote input, and it must not be able to point this tool anywhere else.
        const nextUrl = new URL(next, base);
        if (nextUrl.origin !== base.origin) {
            log(`warning: ignoring Link rel="next" pointing off-instance (${nextUrl.origin}); stopping pagination.`);
            url = null;
            break;
        }
        url = nextUrl.href;
        log(`  … page ${page + 1} done (${following.length} accounts so far)`);
    }

    return { self, following };
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
    const self = fx.verify_credentials;
    if (!self || !self.id) throw new Error(`fixture "${path}" has no verify_credentials.id`);

    const pages = fx.following_pages;
    if (!Array.isArray(pages)) throw new Error(`fixture "${path}" has no following_pages array`);

    // Walk the pages exactly the way the live client walks Link headers, so the
    // pagination loop (and parseLinkNext) is what the fixture actually tests.
    const following = [];
    for (let i = 0; i < pages.length && i < MAX_PAGES; i++) {
        const page = pages[i];
        const accounts = Array.isArray(page) ? page : page.accounts;
        if (!Array.isArray(accounts)) throw new Error(`fixture page ${i + 1} has no accounts array`);
        following.push(...accounts);
        const next = Array.isArray(page) ? null : parseLinkNext(page.link);
        log(`  … fixture page ${i + 1}: ${accounts.length} accounts, next=${next ? "yes" : "no"}`);
        if (!next) break;
    }
    return { self, following };
}

// --------------------------------------------------------- html → text

const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
            try {
                return String.fromCodePoint(code);
            } catch {
                return whole;
            }
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? whole : named;
    });
}

/**
 * Turn a Mastodon `note` (sanitised HTML) into the plain text the person wrote.
 * Block ends become newlines, <br> becomes a newline, remaining tags are dropped,
 * then entities are decoded (after tag removal, so an escaped &lt;b&gt; the person
 * literally typed survives as text). Nothing else is altered — no truncation, no
 * normalisation of their wording, no link rewriting.
 */
export function htmlToText(html) {
    if (typeof html !== "string" || !html) return "";
    let s = html;
    s = s.replace(/\r\n?/g, "\n");
    s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
    s = s.replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|pre)\s*>/gi, "\n\n");
    s = s.replace(/<\s*(li)\b[^>]*>/gi, "\n");
    s = s.replace(/<[^>]*>/g, ""); // drop every remaining tag (incl. <a>, <span>)
    s = decodeEntities(s);
    s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return s.trim();
}

// -------------------------------------------------- profile metadata fields

const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad2 = n => String(n).padStart(2, "0");
const validMD = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/**
 * Parse a birthday the person themselves published in a profile field.
 * Returns "YYYY-MM-DD" (only when THEY stated a year), "MM-DD", or null.
 * A year is never inferred, and a genuinely ambiguous numeric date (03/04) is
 * refused rather than guessed.
 */
export function parseBirthday(input) {
    if (typeof input !== "string") return null;
    const s = htmlToText(input).trim();
    if (!s) return null;

    // ISO, with year: 1990-05-12
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (m) {
        const [, y, mo, d] = m.map(Number);
        return validMD(mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
    }

    // Month name, either order, optional ordinal suffix, optional year.
    const name = "(" + Object.keys(MONTHS).join("|") + ")";
    m = new RegExp(`^${name}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?$`, "i").exec(s);
    if (!m) m = matchDayMonth(s, name);
    if (m) {
        const mo = MONTHS[m[1].toLowerCase()];
        const d = Number(m[2]);
        if (!validMD(mo, d)) return null;
        return m[3] ? `${m[3]}-${pad2(mo)}-${pad2(d)}` : `${pad2(mo)}-${pad2(d)}`;
    }

    // Dash form without a year: 05-12. The dash form is the ISO order, month first.
    m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) {
        const mo = Number(m[1]);
        const d = Number(m[2]);
        return validMD(mo, d) ? `${pad2(mo)}-${pad2(d)}` : null;
    }

    // Slash form: DD/MM and MM/DD are indistinguishable. Accept ONLY when one
    // component is > 12 and therefore can only be the day. Otherwise: refuse.
    m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(s);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        let mo = null;
        let d = null;
        if (a > 12 && b <= 12) { d = a; mo = b; }
        else if (b > 12 && a <= 12) { mo = a; d = b; }
        else return null; // ambiguous — do not guess
        if (!validMD(mo, d)) return null;
        return m[3] ? `${m[3]}-${pad2(mo)}-${pad2(d)}` : `${pad2(mo)}-${pad2(d)}`;
    }

    return null;
}

function matchDayMonth(s, name) {
    const m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name}\\.?(?:\\s*,?\\s*(\\d{4}))?$`, "i").exec(s);
    return m ? [m[0], m[2], m[1], m[3]] : null; // reshape to [all, month, day, year]
}

const PRONOUN_FIELD = /pronouns?/i;
const BIRTHDAY_FIELD = /\b(birthdays?|bday|born)\b/i;

/** Pull pronouns / birthday out of the person's OWN published profile metadata. */
export function readProfileFields(fields) {
    const out = {};
    if (!Array.isArray(fields)) return out;
    for (const f of fields) {
        if (!f || typeof f.name !== "string") continue;
        const name = htmlToText(f.name).trim();
        const value = htmlToText(String(f.value ?? "")).trim();
        if (!value) continue;
        if (out.pronouns === undefined && PRONOUN_FIELD.test(name)) out.pronouns = value;
        else if (out.birthday === undefined && BIRTHDAY_FIELD.test(name)) {
            const bd = parseBirthday(value);
            if (bd) out.birthday = bd; // unparseable → omit, never a placeholder
        }
    }
    return out;
}

// ------------------------------------------------------------- mapping

/** "alice" on your own instance → "@alice@your.instance"; "bob@other" → "@bob@other". */
export function fullHandle(acct, instanceHost) {
    const a = String(acct || "").replace(/^@/, "");
    if (!a) return null;
    return a.includes("@") || !instanceHost ? "@" + a : `@${a}@${instanceHost}`;
}

/** Map one raw Mastodon account to an Orbit Person (allow-listed fields only). */
export function toPerson(raw, instanceHost) {
    if (!raw || raw.id == null) return null;
    const id = String(raw.id).trim();
    const handle = fullHandle(raw.acct ?? raw.username, instanceHost);
    if (!id || !handle) return null;

    const person = {
        source: SOURCE,
        sourceId: id,
        handle,
        displayName: String(raw.display_name || "").trim() || handle,
    };
    const avatar = raw.avatar_static || raw.avatar;
    if (avatar) person.avatarUrl = String(avatar);

    const bio = htmlToText(raw.note);
    if (bio) person.bio = bio; // verbatim; omitted when empty (never a placeholder)

    const { pronouns, birthday } = readProfileFields(raw.fields);
    if (pronouns) person.pronouns = pronouns;
    if (birthday) person.birthday = birthday;

    return person;
}

// --------------------------------------------------------- snapshot

async function loadSnapshot(path) {
    try {
        const s = JSON.parse(await readFile(path, "utf8"));
        if (s && typeof s === "object" && s.accounts && typeof s.accounts === "object") return s;
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
 * Persons are always upserted (idempotent). Observations come only from a diff
 * against the snapshot:
 *   note changed        → bio
 *   display_name changed→ nick   (meta.previous)
 *   avatar url changed  → avatar (meta.previous)
 *   newly followed      → friend (meta.state "followed")
 *   no longer followed  → friend (meta.state "unfollowed")
 *
 * On the very FIRST run there is no snapshot, so "newly followed" would be a
 * lie about when you followed them: the first run baselines current bios and
 * emits no `friend` events. Mastodon has no presence — no `presence` is ever
 * emitted here, by any path.
 */
export function buildBatch(persons, selfPerson, snapshot, now) {
    const observations = [];
    const nextAccounts = {};
    const firstRun = snapshot === null;
    const prevAccounts = snapshot ? snapshot.accounts : {};
    const outPersons = selfPerson ? [selfPerson, ...persons] : [...persons];
    const seen = new Set();

    for (const p of persons) {
        seen.add(p.sourceId);
        const prev = prevAccounts[p.sourceId];
        const bio = p.bio ?? "";
        const name = p.displayName;
        const avatar = p.avatarUrl ?? "";

        if (!prev) {
            if (bio) observations.push({ source: SOURCE, sourceId: p.sourceId, kind: "bio", text: bio, ts: now });
            if (!firstRun)
                observations.push({
                    source: SOURCE, sourceId: p.sourceId, kind: "friend", ts: now,
                    meta: { state: "followed" },
                });
        } else {
            if (name !== prev.displayName)
                observations.push({
                    source: SOURCE, sourceId: p.sourceId, kind: "nick",
                    text: name, ts: now, meta: { previous: prev.displayName },
                });
            if (bio !== (prev.bio ?? "") && bio)
                observations.push({
                    source: SOURCE, sourceId: p.sourceId, kind: "bio",
                    text: bio, ts: now, meta: { previous: prev.bio ?? "" },
                });
            if (avatar && avatar !== (prev.avatarUrl ?? ""))
                observations.push({
                    source: SOURCE, sourceId: p.sourceId, kind: "avatar",
                    ts: now, meta: { previous: prev.avatarUrl ?? "" },
                });
        }

        nextAccounts[p.sourceId] = { handle: p.handle, displayName: name, bio, avatarUrl: avatar };
    }

    // Accounts that were in the snapshot and are not in the following list any
    // more: you unfollowed them (or they left). Re-upsert the person we already
    // knew so the observation always has its subject in-batch, then drop them.
    for (const [id, prev] of Object.entries(prevAccounts)) {
        if (seen.has(id)) continue;
        outPersons.push({
            source: SOURCE, sourceId: id,
            handle: prev.handle || "@" + id,
            displayName: prev.displayName || prev.handle || id,
        });
        observations.push({
            source: SOURCE, sourceId: id, kind: "friend", ts: now,
            meta: { state: "unfollowed" },
        });
    }

    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: now, persons: outPersons, observations };
    return { batch, nextSnapshot: { version: 1, accounts: nextAccounts } };
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
    const instance = opts.instance || process.env.MASTODON_INSTANCE || null;

    // Collect the raw account data (live or fixture).
    let self, following;
    try {
        if (opts.fixture) {
            log(`[fixture] reading canned API responses from ${opts.fixture} (no network)`);
            ({ self, following } = await fixtureSource(opts.fixture, log));
        } else {
            if (!instance) {
                console.error("error: no instance. Pass --instance https://your.instance or set $MASTODON_INSTANCE.");
                return 1;
            }
            const mastodonToken = await resolveMastodonToken(opts.mastodonToken);
            if (!mastodonToken) {
                console.error(
                    "error: no Mastodon access token. Pass --mastodon-token, set $MASTODON_TOKEN, or write it to " +
                    MASTODON_TOKEN_FILE + " (scopes: read:accounts read:follows)."
                );
                return 1;
            }
            ({ self, following } = await liveSource(instance, mastodonToken, log));
        }
    } catch (e) {
        if (e.code === "ENOTFOUND") console.error(`error: could not resolve the instance host (${e.hostname}).`);
        else if (e.code === "ECONNREFUSED") console.error("error: connection refused by the instance.");
        else console.error(`error: ${e.message}`);
        return 1;
    }

    const instanceHost = instance ? new URL(instance).host : hostOf(self.url);
    const persons = following.map(a => toPerson(a, instanceHost)).filter(Boolean);
    if (!persons.length) log("note: your following list is empty — emitting the roster as-is.");

    // The reserved operator identity (SPEC §2.1). Mastodon cannot see presence,
    // so `self` carries identity only: no presence observations exist to attach.
    const selfHandle = fullHandle(self.acct ?? self.username, instanceHost);
    const selfPerson = { source: "self", sourceId: "me", handle: selfHandle || "@me", displayName: String(self.display_name || "").trim() || selfHandle || "(you)" };
    if (self.avatar_static || self.avatar) selfPerson.avatarUrl = String(self.avatar_static || self.avatar);

    const snapPath = snapshotFile(Boolean(opts.fixture));
    const snapshot = await loadSnapshot(snapPath);
    const now = Date.now();
    const { batch, nextSnapshot } = buildBatch(persons, selfPerson, snapshot, now);

    if (opts.dryRun) {
        console.log(JSON.stringify(batch, null, 2));
        console.error(
            `\n[dry-run] ${batch.persons.length} persons, ${batch.observations.length} observations ` +
            `(0 presence — Mastodon publishes none). Not POSTing, snapshot untouched.`
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

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

// Only run as a CLI; importing this file (tests) must not execute main().
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("fatal:", e);
        process.exit(1);
    });
}
