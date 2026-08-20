#!/usr/bin/env node
/*
 * contacts-orbit — NX Orbit external emitter for YOUR OWN address book.
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 nerdrx
 *
 * A standalone Node CLI (ES modules, zero dependencies). It parses vCard (.vcf,
 * 3.0 and 4.0) and iCalendar (.ics) files that YOU exported from YOUR OWN
 * address book / calendar — Google Contacts, Nextcloud, Thunderbird, Apple
 * Contacts, DAVx5 — and turns the birthdays in them into Orbit `Person`
 * upserts. It POSTs one batch (SPEC §3) to the loopback ingest endpoint.
 *
 * This exists because VRChat and Discord do not expose friends' birthdays, so
 * Orbit's birthday board has nothing to work with. Your own address book does.
 *
 * Charter compliance (SPEC §0 / PLUGIN_GUIDELINES five rules):
 *   - Friends-only, first-person: the input is a file the operator hands it,
 *     exported from an address book the operator already owns. There is no
 *     directory lookup, no enrichment, no "find more contacts" path.
 *   - Surface-only: it reads NOTHING over the network. No provider API, no
 *     OAuth, no CardDAV client. `readFile` and nothing else.
 *   - Observations, not conclusions: it emits ZERO observations. A contact card
 *     is static identity data, not an event stream (SPEC §3: an empty
 *     `observations` array is valid). Nothing is inferred, matched or scored —
 *     in particular it never fuzzy-matches a contact to a VRChat/Discord friend;
 *     SPEC §2.1 says only the operator asserts that link, in the UI.
 *   - Verbatim: NOTE is the operator's own note about their own contact (SPEC
 *     §2.1 `note` is explicitly "YOUR private note"). A year-less BDAY stays
 *     year-less: "MM-DD". A year is never invented.
 *   - Local delivery only: the batch goes to 127.0.0.1 with a bearer token.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = "contacts-orbit";
const VERSION = "1.0.0";
const SOURCE = "contacts";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = { port: 8477, token: null, files: [], dirs: [], all: false, full: false, dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") o.dryRun = true;
        else if (a === "--help" || a === "-h") o.help = true;
        else if (a === "--all") o.all = true;
        else if (a === "--full") o.full = true;
        else if (a === "--port") o.port = Number(argv[++i]);
        else if (a === "--token") o.token = argv[++i];
        else if (a === "--file") o.files.push(argv[++i]);
        else if (a === "--dir") o.dirs.push(argv[++i]);
        else if (a.startsWith("--port=")) o.port = Number(a.slice(7));
        else if (a.startsWith("--token=")) o.token = a.slice(8);
        else if (a.startsWith("--file=")) o.files.push(a.slice(7));
        else if (a.startsWith("--dir=")) o.dirs.push(a.slice(6));
        else { console.error(`unknown argument: ${a}`); o.help = true; }
    }
    return o;
}

const HELP = `contacts-orbit ${VERSION} — NX Orbit emitter for birthdays in YOUR OWN address book.

Usage:
  node index.js --file contacts.vcf [--file birthdays.ics] [--dry-run]
  node index.js --dir ~/exports [--dry-run] [--port N] [--token TOKEN]

Options:
  --file <path>   A .vcf (vCard 3.0/4.0) or .ics (iCalendar) file you exported
                  from your own address book / calendar. Repeatable.
  --dir <path>    Every .vcf/.ics directly inside this directory. Repeatable.
  --all           Also ingest contacts that have no birthday (default: skip
                  them — Orbit only wants what it can actually use).
  --full          Ignore the snapshot and re-emit every contact.
  --dry-run       Print the batch JSON to stdout instead of POSTing it. Neither
                  reads nor writes the snapshot: run this FIRST to see exactly
                  what would be ingested.
  --port N        Loopback ingest port (default 8477).
  --token TOKEN   Orbit ingest bearer token. Resolution order:
                    --token  >  $NX_ORBIT_TOKEN  >  ~/.config/nx-orbit/ingest.token

Purely local: this reads the files you point it at and talks to nothing but
127.0.0.1. It never contacts Google, Apple, Nextcloud or any other provider.
Only feed it contacts of people you actually know.`;

// -------------------------------------------------------------- config

const CONFIG_DIR = join(homedir(), ".config", "nx-orbit");
const TOKEN_FILE = join(CONFIG_DIR, "ingest.token");
const SNAPSHOT_FILE = join(CONFIG_DIR, "contacts-orbit.snapshot.json");

async function resolveToken(flagToken) {
    if (flagToken) return flagToken.trim();
    if (process.env.NX_ORBIT_TOKEN) return process.env.NX_ORBIT_TOKEN.trim();
    try {
        return (await readFile(TOKEN_FILE, "utf8")).trim();
    } catch {
        return null;
    }
}

// ------------------------------------------------- line-level parsing
//
// vCard (RFC 6350) and iCalendar (RFC 5545) share a line grammar:
//   [group.]NAME[;PARAM=VALUE]*:VALUE
// with "folding": a line beginning with a space or TAB continues the previous
// one (the single leading whitespace char is dropped, nothing else). vCard 2.1
// exporters (Android, old Nokia) additionally use QUOTED-PRINTABLE soft line
// breaks: a QP-encoded line ending in "=" continues on the next line.

function isQuotedPrintableHead(line) {
    const head = line.slice(0, line.indexOf(":") === -1 ? line.length : line.indexOf(":"));
    return /;\s*(ENCODING\s*=\s*)?QUOTED-PRINTABLE/i.test(head);
}

/** Split raw text into unfolded content lines. */
export function unfold(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    const out = [];
    for (const line of lines) {
        const prev = out.length ? out[out.length - 1] : null;
        if (prev !== null && /^[ \t]/.test(line)) {
            out[out.length - 1] = prev + line.slice(1); // RFC 6350 §3.2 folding
        } else if (prev !== null && prev.endsWith("=") && isQuotedPrintableHead(prev)) {
            out[out.length - 1] = prev.slice(0, -1) + line; // QP soft line break
        } else if (line.trim()) {
            out.push(line);
        }
    }
    return out;
}

/**
 * Split on a separator that is neither backslash-escaped (`\;` inside a value)
 * nor inside a double-quoted parameter value. Escape pairs are kept intact so
 * unescapeText() can resolve them afterwards.
 */
function splitUnquoted(s, sep) {
    const parts = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "\\" && i + 1 < s.length) { cur += c + s[++i]; continue; }
        if (c === '"') { quoted = !quoted; cur += c; }
        else if (c === sep && !quoted) { parts.push(cur); cur = ""; }
        else cur += c;
    }
    parts.push(cur);
    return parts;
}

/** Parse one unfolded content line into { group, name, params, value }. */
export function parseContentLine(line) {
    let quoted = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') quoted = !quoted;
        else if (c === ":" && !quoted) { colon = i; break; }
    }
    if (colon < 0) return null;

    const head = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    const segments = splitUnquoted(head, ";");
    let name = segments.shift().trim();
    let group = null;
    const dot = name.indexOf(".");
    if (dot > 0) { group = name.slice(0, dot).toUpperCase(); name = name.slice(dot + 1); }

    const params = {};
    for (const seg of segments) {
        const s = seg.trim();
        if (!s) continue;
        const eq = s.indexOf("=");
        if (eq < 0) params[s.toUpperCase()] = ""; // vCard 2.1 bare param (…;QUOTED-PRINTABLE:)
        else params[s.slice(0, eq).trim().toUpperCase()] = s.slice(eq + 1).trim().replace(/^"|"$/g, "");
    }
    return { group, name: name.toUpperCase(), params, rawValue };
}

function decodeQuotedPrintable(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
            bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(s.charCodeAt(i) & 0xff);
        }
    }
    return Buffer.from(bytes).toString("utf8");
}

/** Unescape RFC 6350 §3.4 text: \n \N → newline, \, \; \: \\ → the literal char. */
function unescapeText(s) {
    return s.replace(/\\([\\;,:nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function isQuotedPrintable(line) {
    return (
        "QUOTED-PRINTABLE" in line.params ||
        /^QUOTED-PRINTABLE$/i.test(line.params.ENCODING ?? "")
    );
}

/** Full value decode: QUOTED-PRINTABLE first (a transport encoding), then escapes. */
function decodeValue(line) {
    const raw = isQuotedPrintable(line) ? decodeQuotedPrintable(line.rawValue) : line.rawValue;
    return unescapeText(raw).trim();
}

/** Split a multi-part value on an UNESCAPED separator, then decode each part. */
function listValue(line, sep) {
    const raw = isQuotedPrintable(line) ? decodeQuotedPrintable(line.rawValue) : line.rawValue;
    return splitUnquoted(raw, sep).map(v => unescapeText(v).trim());
}

/** Structured value (N, ADR, X-ANDROID-CUSTOM) — ";"-separated components. */
function structured(line) {
    return listValue(line, ";");
}

// ------------------------------------------------------- birthdays
//
// SPEC §2.1: birthday is "MM-DD" | "YYYY-MM-DD" | null, "NO year unless they
// stated it". A year-omitted vCard 4.0 BDAY (`--0517`), an Apple
// X-APPLE-OMIT-YEAR card, or a recurring calendar event therefore stays MM-DD.
// We never back-fill a year, and never drop a year that was really stated.

const APPLE_OMIT_YEAR = "1604"; // Apple Contacts' documented "no year" sentinel

function validMonthDay(mm, dd) {
    const m = Number(mm);
    const d = Number(dd);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** Normalise any BDAY/DATE value to "MM-DD" or "YYYY-MM-DD"; null if unusable. */
export function normalizeBirthday(value, params = {}) {
    let v = String(value ?? "").trim();
    if (!v) return null;
    v = v.split(/[T ]/)[0].replace(/Z$/i, ""); // drop any time part

    // vCard 4.0 year-omitted: --MMDD / --MM-DD  (and the rarer --MM)
    let m = /^--(\d{2})-?(\d{2})$/.exec(v);
    if (m) return validMonthDay(m[1], m[2]) ? `${m[1]}-${m[2]}` : null;

    m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
    if (m) {
        const [, y, mo, d] = m;
        if (!validMonthDay(mo, d)) return null;
        const omit = String(params["X-APPLE-OMIT-YEAR"] ?? "");
        // A sentinel year is a placeholder the exporter wrote, not a year the
        // person stated — strip it rather than pretend they were born in 1604.
        if (y === APPLE_OMIT_YEAR || (omit && omit === y)) return `${mo}-${d}`;
        return `${y}-${mo}-${d}`;
    }
    return null;
}

/** Prefer a birthday that carries a real year over the same day without one. */
function betterBirthday(a, b) {
    if (!a) return b ?? null;
    if (!b) return a;
    if (a.length === b.length) return a;
    return a.length > b.length ? a : b;
}

// ------------------------------------------------------ vCard cards

function stableId(name) {
    return createHash("sha1").update(name.toLowerCase().replace(/\s+/g, " ").trim(), "utf8").digest("hex");
}

function nonEmpty(v) {
    const s = typeof v === "string" ? v.trim() : "";
    return s || null;
}

/** Parse a .vcf document into contact records. */
export function parseVcf(text) {
    const contacts = [];
    let card = null;
    for (const raw of unfold(text)) {
        const line = parseContentLine(raw);
        if (!line) continue;
        if (line.name === "BEGIN" && /^VCARD$/i.test(line.rawValue.trim())) {
            card = { lines: [], groups: new Map() };
            continue;
        }
        if (line.name === "END" && /^VCARD$/i.test(line.rawValue.trim())) {
            if (card) contacts.push(cardToContact(card));
            card = null;
            continue;
        }
        if (!card) continue;
        card.lines.push(line);
        if (line.group) {
            if (!card.groups.has(line.group)) card.groups.set(line.group, []);
            card.groups.get(line.group).push(line);
        }
    }
    return contacts.filter(Boolean);
}

function cardToContact(card) {
    const first = n => card.lines.find(l => l.name === n && !l.group);
    const firstAny = n => card.lines.find(l => l.name === n);

    // --- display name: FN, else N (Family;Given;Middle;Prefix;Suffix), else NICKNAME
    let displayName = nonEmpty(first("FN") ? decodeValue(first("FN")) : null);
    if (!displayName) {
        const n = firstAny("N");
        if (n) {
            const [family, given, middle] = structured(n);
            displayName = nonEmpty([given, middle, family].filter(Boolean).join(" "));
        }
    }
    const nickLine = firstAny("NICKNAME");
    const nickname = nickLine ? nonEmpty(listValue(nickLine, ",")[0]) : null;
    if (!displayName) displayName = nickname;
    if (!displayName) return null; // a card with no name at all is not a person we can show

    // --- birthday: BDAY, else an item-group X-ABDATE labelled "birthday",
    //     else Android's X-ANDROID-CUSTOM contact_event with type 3 (= birthday).
    let birthday = null;
    const bday = firstAny("BDAY");
    if (bday) birthday = normalizeBirthday(decodeValue(bday), bday.params);

    if (!birthday) {
        for (const [, lines] of card.groups) {
            const date = lines.find(l => l.name === "X-ABDATE");
            const label = lines.find(l => l.name === "X-ABLABEL");
            if (date && label && /birthday/i.test(decodeValue(label)))
                birthday = normalizeBirthday(decodeValue(date), date.params);
            if (birthday) break;
        }
    }
    if (!birthday) {
        for (const l of card.lines) {
            if (l.name !== "X-ANDROID-CUSTOM") continue;
            const parts = structured(l);
            // vnd.android.cursor.item/contact_event;<date>;<type>;… — type 3 = birthday
            if (!/contact_event/i.test(parts[0] ?? "")) continue;
            if ((parts[2] ?? "").trim() !== "3") continue;
            birthday = normalizeBirthday(parts[1]);
            if (birthday) break;
        }
    }

    const noteLine = firstAny("NOTE");
    const uidLine = firstAny("UID");
    const uid = uidLine ? nonEmpty(decodeValue(uidLine)) : null;

    return {
        sourceId: uid ?? stableId(displayName),
        displayName,
        handle: nickname,
        birthday,
        note: noteLine ? nonEmpty(decodeValue(noteLine)) : null,
    };
}

// --------------------------------------------------- iCalendar events
//
// Birthday VEVENTs, as exported by Google/Apple/Nextcloud/Thunderbird. The
// DTSTART year of a yearly-recurring birthday event is NOT reliably the birth
// year (many exporters write the first occurrence), so an .ics birthday is
// always emitted as MM-DD. Better a missing year than an invented one.

const SUMMARY_PATTERNS = [
    /^(.+?)[’']s\s+birthday$/i,
    /^birthday\s*[:\-]\s*(.+)$/i,
    /^birthday\s+of\s+(.+)$/i,
    /^(.+?)\s+has\s+a\s+birthday.*$/i,
    /^🎂\s*(.+)$/u,
    /^geburtstag\s+von\s+(.+)$/i,
    /^(.+?)\s+hat\s+geburtstag$/i,
];

function looksLikeBirthday(props) {
    const cat = props.find(p => p.name === "CATEGORIES");
    if (cat && /birthday|geburtstag/i.test(decodeValue(cat))) return true;
    for (const p of props) {
        if (!p.name.startsWith("X-")) continue;
        if (p.name.includes("BIRTHDAY")) return true;
        if (/birthday/i.test(p.rawValue)) return true;
    }
    const rrule = props.find(p => p.name === "RRULE");
    const summary = props.find(p => p.name === "SUMMARY");
    if (rrule && /FREQ=YEARLY/i.test(rrule.rawValue) && summary) {
        const s = decodeValue(summary);
        return SUMMARY_PATTERNS.some(re => re.test(s));
    }
    return false;
}

function nameFromSummary(summary) {
    for (const re of SUMMARY_PATTERNS) {
        const m = re.exec(summary);
        if (m) return nonEmpty(m[1]);
    }
    return nonEmpty(summary); // marked a birthday by CATEGORIES/X-: the summary IS the name
}

/** Parse an .ics document into contact records (birthday events only). */
export function parseIcs(text) {
    const contacts = [];
    let props = null;
    for (const raw of unfold(text)) {
        const line = parseContentLine(raw);
        if (!line) continue;
        if (line.name === "BEGIN" && /^VEVENT$/i.test(line.rawValue.trim())) { props = []; continue; }
        if (line.name === "END" && /^VEVENT$/i.test(line.rawValue.trim())) {
            if (props) {
                const c = eventToContact(props);
                if (c) contacts.push(c);
            }
            props = null;
            continue;
        }
        if (props) props.push(line);
    }
    return contacts;
}

function eventToContact(props) {
    if (!looksLikeBirthday(props)) return null;
    const summary = props.find(p => p.name === "SUMMARY");
    if (!summary) return null;
    const displayName = nameFromSummary(decodeValue(summary));
    if (!displayName) return null;
    const dtstart = props.find(p => p.name === "DTSTART");
    const full = dtstart ? normalizeBirthday(decodeValue(dtstart), dtstart.params) : null;
    if (!full) return null;
    // Year-drop: see the block comment above. "YYYY-MM-DD" → "MM-DD".
    const birthday = full.length === 10 ? full.slice(5) : full;
    return { sourceId: stableId(displayName), displayName, handle: null, birthday, note: null };
}

// -------------------------------------------------------- file input

async function collectFiles(opts) {
    const files = [...opts.files];
    for (const dir of opts.dirs) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!e.isFile()) continue;
            if (/^\.(vcf|vcard|ics|ical|ifb)$/i.test(extname(e.name))) files.push(join(dir, e.name));
        }
    }
    return files;
}

/** Parse one file, sniffing the format when the extension does not say. */
export function parseDocument(text, filename = "") {
    const ext = extname(filename).toLowerCase();
    if (ext === ".vcf" || ext === ".vcard") return parseVcf(text);
    if (ext === ".ics" || ext === ".ical" || ext === ".ifb") return parseIcs(text);
    if (/BEGIN:VCARD/i.test(text)) return parseVcf(text);
    if (/BEGIN:VCALENDAR/i.test(text)) return parseIcs(text);
    throw new Error("not a vCard or iCalendar document");
}

// ------------------------------------------------------ batch build

/**
 * Merge parsed contacts into Person upserts.
 *
 * Records that share a sourceId (the same vCard UID, or the same normalised
 * name in a UID-less card / .ics event) are merged — this is deduplication of
 * the operator's own address book, NOT identity matching. contacts-orbit never
 * links a contact to a VRChat/Discord person: SPEC §2.1 reserves that for the
 * operator, in the UI.
 */
export function buildBatch({ contacts, snapshot = {}, includeAll = false, now = Date.now() }) {
    const merged = new Map();
    let skippedNoBirthday = 0;

    for (const c of contacts) {
        if (!c.birthday && !includeAll) { skippedNoBirthday++; continue; }
        const prev = merged.get(c.sourceId);
        if (!prev) {
            merged.set(c.sourceId, { ...c });
            continue;
        }
        prev.birthday = betterBirthday(prev.birthday, c.birthday);
        prev.handle = prev.handle ?? c.handle;
        prev.note = prev.note ?? c.note;
    }

    const persons = [];
    const nextSnapshot = {};
    let unchanged = 0;
    for (const c of merged.values()) {
        const person = { source: SOURCE, sourceId: c.sourceId, displayName: c.displayName };
        if (c.handle) person.handle = c.handle;
        if (c.birthday) person.birthday = c.birthday;
        if (c.note) person.note = c.note;

        const fingerprint = createHash("sha1").update(JSON.stringify(person), "utf8").digest("hex");
        nextSnapshot[c.sourceId] = fingerprint;
        if (snapshot[c.sourceId] === fingerprint) { unchanged++; continue; }
        persons.push(person);
    }

    // No observations, ever: a contact card is identity data, not an event.
    const batch = { plugin: PLUGIN, version: VERSION, emittedAt: now, persons, observations: [] };
    return { batch, nextSnapshot, stats: { parsed: contacts.length, merged: merged.size, unchanged, skippedNoBirthday } };
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
    if (!opts.files.length && !opts.dirs.length) {
        console.error("error: nothing to read. Pass --file <contacts.vcf> (repeatable) or --dir <folder>. See --help.");
        return 1;
    }

    let files;
    try {
        files = await collectFiles(opts);
    } catch (e) {
        console.error(`error: could not list --dir: ${e.message}`);
        return 1;
    }
    if (!files.length) {
        console.error("error: no .vcf/.ics files found in the paths given.");
        return 1;
    }

    const contacts = [];
    for (const file of files) {
        let text;
        try {
            text = await readFile(file, "utf8");
        } catch (e) {
            console.error(`error: could not read "${file}": ${e.message}`);
            return 1;
        }
        try {
            const got = parseDocument(text, file);
            contacts.push(...got);
            console.error(`read ${file}: ${got.length} contact(s)`);
        } catch (e) {
            console.error(`error: "${file}": ${e.message}`);
            return 1;
        }
    }
    if (!contacts.length) {
        console.error("error: no contacts parsed from the given files.");
        return 1;
    }

    // --dry-run neither reads nor writes the snapshot: it always shows the full
    // baseline, which is exactly what you want before ingesting an address book.
    const snapshot = opts.dryRun || opts.full ? {} : await loadSnapshot();
    const now = Date.now();
    const { batch, nextSnapshot, stats } = buildBatch({
        contacts,
        snapshot,
        includeAll: opts.all,
        now,
    });

    if (opts.dryRun) {
        console.log(JSON.stringify(batch, null, 2));
        console.error(
            `\n[dry-run] ${batch.persons.length} persons, 0 observations ` +
            `(${stats.parsed} parsed, ${stats.merged} after merging duplicates, ` +
            `${stats.skippedNoBirthday} skipped for having no birthday${opts.all ? " (--all: none skipped)" : " — pass --all to include them"}).\n` +
            `[dry-run] Not POSTing, snapshot untouched.`
        );
        return 0;
    }

    if (!batch.persons.length) {
        console.log(`ok: nothing to do — all ${stats.unchanged} contacts are unchanged since the last run (--full re-emits them).`);
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
        console.log(`ok: ${res.body || "{}"}  (${batch.persons.length} persons, ${stats.unchanged} unchanged)`);
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

// Only run when invoked as a CLI, so tests can import the parsers directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("fatal:", e);
        process.exit(1);
    });
}
