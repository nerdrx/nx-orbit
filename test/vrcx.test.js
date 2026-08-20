// Tests for the VRCX in-process reader (src/main/plugins/vrcx.js).
// Run: node --test test/vrcx.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  collect,
  meta,
  numToEpochMs,
  isoToEpochMs,
  toEventMs,
  isPlausibleEpochMs,
  mapStatus,
  discoverPrefix,
  usrIdFromPrefix,
  mergeSessions,
  buildSelfSessions,
} from "../src/main/plugins/vrcx.js";

const OBS_KINDS = new Set([
  "presence",
  "status",
  "location",
  "bio",
  "nick",
  "avatar",
  "friend",
]);
const STATUS_ENUM = new Set([
  "online",
  "active",
  "joinme",
  "askme",
  "busy",
  "offline",
]);

const REAL_DB = path.join(os.homedir(), ".config", "VRCX", "VRCX.sqlite3");

// ---------------------------------------------------------------------------
// Unit: timestamp normalizer
// ---------------------------------------------------------------------------

test("numToEpochMs classifies sec/ms/µs/ticks by magnitude", () => {
  const ms = 1755000000000; // ~2025-08
  const sec = 1755000000;
  const us = 1755000000000000;
  // .NET ticks for the same instant: ms*10000 + epoch offset
  const ticks = ms * 10000 + 621355968000000000;

  assert.equal(numToEpochMs(ms), ms);
  assert.equal(numToEpochMs(sec), ms);
  assert.equal(numToEpochMs(us), ms);
  assert.equal(numToEpochMs(ticks), ms);
});

test("numToEpochMs rejects small values (durations) and junk", () => {
  assert.equal(numToEpochMs(12229067), null); // a VRCX session duration in ms
  assert.equal(numToEpochMs(0), null);
  assert.equal(numToEpochMs(-5), null);
  assert.equal(numToEpochMs(NaN), null);
  assert.equal(numToEpochMs("nope"), null);
});

test("isoToEpochMs parses ISO and rejects blanks", () => {
  assert.equal(isoToEpochMs("2026-08-18T00:22:15.927Z"), Date.parse("2026-08-18T00:22:15.927Z"));
  assert.equal(isoToEpochMs(""), null);
  assert.equal(isoToEpochMs("   "), null);
  assert.equal(isoToEpochMs(null), null);
  assert.equal(isoToEpochMs("garbage"), null);
});

test("isPlausibleEpochMs windows to 2000..2100", () => {
  assert.equal(isPlausibleEpochMs(Date.parse("2026-01-01T00:00:00Z")), true);
  assert.equal(isPlausibleEpochMs(12229067), false); // 1970
  assert.equal(isPlausibleEpochMs(Date.parse("1999-12-31T00:00:00Z")), false);
});

test("toEventMs prefers created_at; ignores duration-like time", () => {
  const iso = "2026-08-18T00:22:15.927Z";
  const expected = Date.parse(iso);
  // time is a session duration (ms) — must be ignored in favor of created_at.
  assert.equal(toEventMs(iso, 12229067), expected);
  // time empty string — created_at still used.
  assert.equal(toEventMs(iso, ""), expected);
  // no created_at, no usable time → null.
  assert.equal(toEventMs("", ""), null);
  // no created_at but a plausible epoch-seconds time → used.
  assert.equal(toEventMs("", 1755000000), 1755000000000);
});

test("mapStatus maps VRChat rings to SPEC enum", () => {
  assert.equal(mapStatus("active"), "active");
  assert.equal(mapStatus("join me"), "joinme");
  assert.equal(mapStatus("ask me"), "askme");
  assert.equal(mapStatus("busy"), "busy");
  assert.equal(mapStatus("JOIN ME"), "joinme");
  assert.equal(mapStatus("weird"), null);
});

// ---------------------------------------------------------------------------
// Unit: the operator's own sessions ("me" axis)
// ---------------------------------------------------------------------------

const H = 3600000;

// A synthetic UUID on purpose: this is a public repo, and a real VRChat user id
// resolves to a real person's profile. The transformation under test is pure
// string surgery, so any well-formed uuid exercises it identically.
test("usrIdFromPrefix rebuilds usr_<uuid> from the table prefix", () => {
  assert.equal(
    usrIdFromPrefix("usr0123456789abcdef0123456789abcdef"),
    "usr_01234567-89ab-cdef-0123-456789abcdef"
  );
  assert.equal(usrIdFromPrefix("usrshort"), null);
  assert.equal(usrIdFromPrefix(null), null);
  assert.equal(usrIdFromPrefix("nope0123456789abcdef0123456789abcdef"), null);
});

test("mergeSessions unions overlapping and touching sessions only", () => {
  // unsorted input, one overlap, one exact touch, one real gap
  assert.deepEqual(
    mergeSessions([
      [300, 400],
      [0, 100],
      [50, 120], // overlaps the first
      [120, 200], // touches
    ]),
    [
      [0, 200],
      [300, 400],
    ]
  );
  // a gap is never bridged — that would assert presence nobody recorded
  assert.deepEqual(mergeSessions([[0, 100], [101, 200]]), [[0, 100], [101, 200]]);
  // zero-length and malformed entries are dropped
  assert.deepEqual(mergeSessions([[5, 5], [10, 4], [NaN, 9], null, [1, 2]]), [[1, 2]]);
  assert.deepEqual(mergeSessions([]), []);
});

test("buildSelfSessions: a positive plausible duration closes the session", () => {
  const t = Date.UTC(2026, 7, 18, 0, 0, 0);
  assert.deepEqual(buildSelfSessions([{ ts: t, duration: 2 * H }]), [[t, t + 2 * H]]);
});

test("buildSelfSessions: no usable duration falls back to the next location row", () => {
  const t = Date.UTC(2026, 7, 18, 0, 0, 0);
  // zero duration → ends when the next world was entered (1h later)
  assert.deepEqual(
    buildSelfSessions([
      { ts: t, duration: 0 },
      { ts: t + H, duration: 30 * 60000 },
    ]),
    [[t, t + H + 30 * 60000]] // the two sessions touch, so they merge
  );
  // the fallback gap itself must be plausible: a 3-day gap means the game was
  // closed, not that the operator sat in one world for three days.
  assert.deepEqual(
    buildSelfSessions([
      { ts: t, duration: 0 },
      { ts: t + 72 * H, duration: H },
    ]),
    [[t + 72 * H, t + 73 * H]]
  );
});

test("buildSelfSessions: absent/absurd durations are dropped, never invented", () => {
  const t = Date.UTC(2026, 7, 18, 0, 0, 0);
  // absurd duration and no later row to fall back to → nothing at all
  assert.deepEqual(buildSelfSessions([{ ts: t, duration: 400 * H }]), []);
  assert.deepEqual(buildSelfSessions([{ ts: t, duration: null }]), []);
  assert.deepEqual(buildSelfSessions([{ ts: t, duration: -5 }]), []);
  assert.deepEqual(buildSelfSessions([]), []);
});

test("buildSelfSessions: an OnPlayerLeft row describes a whole session backwards", () => {
  const t = Date.UTC(2026, 7, 18, 6, 0, 0);
  // `time` on a leave row is the time spent in the instance → [leave-time, leave]
  assert.deepEqual(buildSelfSessions([], [{ ts: t, duration: 2 * H }]), [[t - 2 * H, t]]);
  // and the same sanity bounds apply
  assert.deepEqual(buildSelfSessions([], [{ ts: t, duration: 0 }]), []);
  assert.deepEqual(buildSelfSessions([], [{ ts: t, duration: 400 * H }]), []);
});

// ---------------------------------------------------------------------------
// Shared batch invariants (asserted for both real and synthetic sources)
// ---------------------------------------------------------------------------

// The heatmap's "me" axis needs DURATION, so self presence must arrive as
// strictly alternating online/offline pairs with a positive length. Returns the
// [start, end] sessions those records describe.
function assertAlternatingSessions(selfObs) {
  assert.ok(selfObs.length > 0, "operator presence emitted");
  assert.equal(selfObs.length % 2, 0, "self presence comes in open/close pairs");
  const sessions = [];
  for (let i = 0; i < selfObs.length; i += 2) {
    const a = selfObs[i];
    const b = selfObs[i + 1];
    assert.equal(a.status, "online", `record ${i} opens`);
    assert.equal(b.status, "offline", `record ${i + 1} closes`);
    assert.ok(b.ts > a.ts, "a session has positive length");
    if (sessions.length) assert.ok(a.ts > sessions[sessions.length - 1][1], "sessions do not overlap");
    sessions.push([a.ts, b.ts]);
  }
  return sessions;
}

function assertBatchWellFormed(batch) {
  assert.equal(batch.plugin, "vrcx");
  assert.equal(typeof batch.version, "string");
  assert.equal(typeof batch.emittedAt, "number");
  assert.ok(Array.isArray(batch.persons));
  assert.ok(Array.isArray(batch.observations));

  const known = new Set();
  for (const p of batch.persons) {
    assert.ok(p.source, "person has source");
    assert.ok(p.sourceId, "person has sourceId");
    known.add(p.source + " " + p.sourceId);
  }

  for (const o of batch.observations) {
    // kind must be in the closed enum — the core rejects anything else.
    assert.ok(OBS_KINDS.has(o.kind), `kind "${o.kind}" in enum`);
    // ts must be numeric epoch-ms.
    assert.equal(typeof o.ts, "number");
    assert.ok(Number.isFinite(o.ts) && o.ts > 0, "ts is positive finite ms");
    assert.ok(isPlausibleEpochMs(o.ts), `ts ${o.ts} in plausible window`);
    // status, if present, must be a valid enum value.
    if (o.status !== undefined) assert.ok(STATUS_ENUM.has(o.status), `status "${o.status}"`);
    // every observation must be about a person present in the batch.
    assert.ok(
      known.has(o.source + " " + o.sourceId),
      "observation references a person in the batch"
    );
  }
}

// ---------------------------------------------------------------------------
// Real DB (if present)
// ---------------------------------------------------------------------------

test("collect() against the real VRCX db", { skip: !fs.existsSync(REAL_DB) }, async () => {
  const batch = await collect({ vrcxDbPath: REAL_DB, log: () => {} });
  assertBatchWellFormed(batch);

  const friends = batch.persons.filter((p) => p.source === "vrcx");
  assert.ok(friends.length > 0, "has vrcx friend persons");

  const byKind = {};
  for (const o of batch.observations) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  assert.ok((byKind.presence ?? 0) > 0, "has presence observations");

  // status text preserved verbatim: cross-check a sampled status row.
  const statusObs = batch.observations.filter((o) => o.kind === "status" && o.text);
  for (const o of statusObs.slice(0, 20)) {
    assert.equal(typeof o.text, "string");
    assert.ok(o.text.length > 0);
  }

  // self axis present.
  const self = batch.persons.find((p) => p.source === "self" && p.sourceId === "me");
  assert.ok(self, "self person emitted");

  // …and it has DURATION: alternating pairs, every session inside a day.
  const selfObs = batch.observations
    .filter((o) => o.source === "self")
    .sort((a, b) => a.ts - b.ts);
  const sessions = assertAlternatingSessions(selfObs);
  const DAY = 24 * 3600000;
  for (const [s, e] of sessions) assert.ok(e - s <= DAY, "no session longer than a day");
  const hours = sessions.reduce((n, [s, e]) => n + (e - s), 0) / 3600000;

  // eslint-disable-next-line no-console
  console.log("real-db counts:", {
    persons: batch.persons.length,
    friends: friends.length,
    byKind,
    selfSessions: sessions.length,
    selfHours: Number(hours.toFixed(2)),
  });
});

// ---------------------------------------------------------------------------
// Synthetic fixture (always runs — validates mapping independent of real db)
// ---------------------------------------------------------------------------

function buildFixture(dir) {
  const dbPath = path.join(dir, "VRCX.sqlite3");
  const db = new DatabaseSync(dbPath);
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const P = "usr" + uuid.replace(/-/g, "");
  const FRIEND = "usr_11111111-1111-1111-1111-111111111111";
  const STRANGER = "usr_99999999-9999-9999-9999-999999999999";

  db.exec("CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO configs VALUES (?, ?)").run(
    "config:friendloginit_usr_" + uuid,
    "true"
  );

  db.exec(
    `CREATE TABLE ${P}_friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number INTEGER)`
  );
  db.prepare(`INSERT INTO ${P}_friend_log_current VALUES (?,?,?,?)`).run(
    FRIEND, "Friendo", "Trusted User", 1
  );

  db.exec(
    `CREATE TABLE ${P}_feed_online_offline (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT)`
  );
  const oo = db.prepare(`INSERT INTO ${P}_feed_online_offline (created_at,user_id,display_name,type,location,world_name,time) VALUES (?,?,?,?,?,?,?)`);
  oo.run("2026-08-18T00:10:00.000Z", FRIEND, "Friendo", "Online", "wrld:1", "Cool World", "");
  oo.run("2026-08-18T02:10:00.000Z", FRIEND, "Friendo", "Offline", "wrld:1", "", 7200000);
  // stranger presence must be dropped.
  oo.run("2026-08-18T01:00:00.000Z", STRANGER, "Nope", "Online", "wrld:2", "Secret", "");

  db.exec(
    `CREATE TABLE ${P}_feed_status (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT)`
  );
  db.prepare(`INSERT INTO ${P}_feed_status (created_at,user_id,display_name,status,status_description) VALUES (?,?,?,?,?)`)
    .run("2026-08-18T00:30:00.000Z", FRIEND, "Friendo", "join me", "🏖 away till the 20th");

  db.exec(
    `CREATE TABLE ${P}_feed_bio (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT)`
  );
  db.prepare(`INSERT INTO ${P}_feed_bio (created_at,user_id,display_name,bio,previous_bio) VALUES (?,?,?,?,?)`)
    .run("2026-08-17T00:00:00.000Z", FRIEND, "Friendo", "i like DnB", "old bio");

  db.exec(
    `CREATE TABLE ${P}_notes (user_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, created_at TEXT)`
  );
  db.prepare(`INSERT INTO ${P}_notes VALUES (?,?,?,?)`)
    .run(FRIEND, "Friendo", "met at Framework's world", "2026-08-01T00:00:00.000Z");

  db.exec(
    `CREATE TABLE ${P}_friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER)`
  );
  db.prepare(`INSERT INTO ${P}_friend_log_history (created_at,type,user_id,display_name,previous_display_name) VALUES (?,?,?,?,?)`)
    .run("2026-08-16T00:00:00.000Z", "DisplayName", FRIEND, "Friendo", "Frienda");

  // gamelog_location.time is a session DURATION in ms, never an epoch. The rows
  // below cover every messy case the reader has to survive.
  db.exec(
    "CREATE TABLE gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT, UNIQUE(created_at, location))"
  );
  const loc = db.prepare(
    "INSERT INTO gamelog_location (created_at,location,world_id,world_name,time) VALUES (?,?,?,?,?)"
  );
  // absurd duration (11.5 days) and the next row is 36h away → unusable, dropped
  loc.run("2026-08-16T00:00:00.000Z", "wrld:0", "wrld_0", "Absurd", 999999999);
  // zero duration → falls back to the gap until the next row (12h05m, plausible)
  loc.run("2026-08-17T12:00:00.000Z", "wrld:2", "wrld_2", "Zero Dur", 0);
  loc.run("2026-08-18T00:05:00.000Z", "wrld:1", "wrld_1", "Cool World", 99544);
  // zero duration → gap until the next row is 1h30m
  loc.run("2026-08-18T03:00:00.000Z", "wrld:3", "wrld_3", "Gap Filled", 0);
  loc.run("2026-08-18T04:30:00.000Z", "wrld:4", "wrld_4", "Half Hour", 1800000);

  db.exec(
    "CREATE TABLE gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER, UNIQUE(created_at, type, display_name))"
  );
  const jl = db.prepare(
    "INSERT INTO gamelog_join_leave (created_at,type,display_name,location,user_id,time) VALUES (?,?,?,?,?,?)"
  );
  const OPERATOR = "usr_" + uuid;
  // the operator's own leave row: [06:00 - 1h, 06:00], touching the 04:30 session
  jl.run("2026-08-18T06:00:00.000Z", "OnPlayerLeft", "Me", "wrld:4", OPERATOR, 3600000);
  jl.run("2026-08-18T05:00:00.000Z", "OnPlayerJoined", "Me", "wrld:4", OPERATOR, 0);
  // somebody else's leave row — must never become operator presence
  jl.run("2026-08-19T10:00:00.000Z", "OnPlayerLeft", "Friendo", "wrld:9", FRIEND, 7200000);

  db.close();
  return { dbPath, FRIEND, STRANGER, OPERATOR };
}

test("collect() against a synthetic fixture maps every table", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrcx-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { dbPath, FRIEND, STRANGER } = buildFixture(dir);

  const batch = await collect({ vrcxDbPath: dbPath, log: () => {} });
  assertBatchWellFormed(batch);

  // Persons: the one friend + self, nothing about the stranger.
  const friend = batch.persons.find((p) => p.source === "vrcx" && p.sourceId === FRIEND);
  assert.ok(friend, "friend person present");
  assert.equal(friend.bio, "i like DnB", "latest bio set on person");
  assert.equal(friend.note, "met at Framework's world", "operator note set on person");
  assert.ok(!("trust_level" in friend), "trust_level not smuggled into person");

  assert.ok(
    !batch.persons.some((p) => p.sourceId === STRANGER),
    "stranger not emitted as a person"
  );
  assert.ok(
    !batch.observations.some((o) => o.sourceId === STRANGER),
    "no observations about the stranger"
  );

  const self = batch.persons.find((p) => p.source === "self" && p.sourceId === "me");
  assert.ok(self, "self person present");

  const kinds = batch.observations.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {});
  assert.ok(kinds.presence >= 3, "presence: friend online+offline + self"); // 2 friend + 1 self
  assert.ok(kinds.location >= 1, "location from non-empty world_name");
  assert.equal(kinds.status, 1);
  assert.equal(kinds.bio, 1);
  assert.equal(kinds.nick, 1);

  // status text preserved verbatim + status mapped.
  const s = batch.observations.find((o) => o.kind === "status");
  assert.equal(s.status, "joinme");
  assert.equal(s.text, "🏖 away till the 20th");

  // presence status enum values.
  const online = batch.observations.find((o) => o.kind === "presence" && o.sourceId === FRIEND && o.status === "online");
  const offline = batch.observations.find((o) => o.kind === "presence" && o.sourceId === FRIEND && o.status === "offline");
  assert.ok(online && online.place === "Cool World", "online presence carries world");
  assert.ok(offline, "offline presence present");

  // ---- the operator's "me" axis: PAIRS with real duration, not instants ----
  const selfObs = batch.observations
    .filter((o) => o.source === "self")
    .sort((a, b) => a.ts - b.ts);
  const sessions = assertAlternatingSessions(selfObs);

  // Expected, from the fixture's messy gamelog rows:
  //   - the "Absurd" row is dropped (11.5d duration, 36h to the next row)
  //   - "Zero Dur" falls back to the 12h05m gap, and touches "Cool World",
  //     which merges the two into one session
  //   - "Gap Filled" + "Half Hour" + the operator's OnPlayerLeft all touch and
  //     merge into one 03:00→06:00 session
  assert.deepEqual(
    sessions.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]),
    [
      ["2026-08-17T12:00:00.000Z", "2026-08-18T00:06:39.544Z"],
      ["2026-08-18T03:00:00.000Z", "2026-08-18T06:00:00.000Z"],
    ]
  );

  // The stranger's OnPlayerLeft on the 19th must not have produced any presence.
  assert.ok(
    !selfObs.some((o) => o.ts >= Date.parse("2026-08-19T00:00:00.000Z")),
    "another player's leave row never becomes the operator's presence"
  );
  // A merged session spans several worlds, so it carries no single `place`.
  assert.ok(selfObs.every((o) => o.place === undefined));
});

test("discoverPrefix derives prefix from configs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrcx-prefix-"));
  try {
    const { dbPath } = buildFixture(dir);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const found = discoverPrefix(db);
    db.close();
    assert.equal(found.prefix, "usr" + "aaaaaaaabbbbccccddddeeeeeeeeeeee");
    assert.equal(found.usrId, "usr_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("meta is well-formed", () => {
  assert.equal(meta.name, "vrcx");
  assert.equal(meta.source, "vrcx");
  assert.equal(typeof meta.version, "string");
});
