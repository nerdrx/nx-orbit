// src/main/db.js — the ONLY module that opens the Orbit SQLite database.
// Storage schema is SPEC §4 verbatim. Pure Node (node:sqlite), no electron,
// so db/ingest/digest stay unit-testable without an Electron runtime.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as paths from './paths.js';

export const SCHEMA_VERSION = 1;

// Reserved "operator" identity. Self-presence observations (for the overlap
// heatmap's "me" axis) are keyed to this person. It is core-managed and seeded
// on open() so plugins can emit observations about it without upserting it.
export const SELF = Object.freeze({ source: 'self', sourceId: 'me' });

// Default on-disk location (SPEC §4). Resolved through paths.js — the single
// config-dir helper — so a dev build launched with $NX_ORBIT_CONFIG_DIR can
// never open the installed build's database. Tests pass an explicit path.
export function defaultDbPath() {
  return paths.dbPath();
}

let db = null;

// ---------------------------------------------------------------------------
// open / schema / migrations
// ---------------------------------------------------------------------------

export function open(dbPath = defaultDbPath()) {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  seedSelf();
  return db;
}

export function getDb() {
  if (!db) throw new Error('db not open — call open() first');
  return db;
}

export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// Migration ladder. Each entry is applied in order when the stored
// schema_version is below its index. Add new migrations by appending.
const MIGRATIONS = [
  // v1 — initial schema (SPEC §4, verbatim column set)
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS person (
        source TEXT NOT NULL, source_id TEXT NOT NULL,
        handle TEXT, display_name TEXT, avatar_url TEXT,
        birthday TEXT, pronouns TEXT, bio TEXT, note TEXT,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY (source, source_id)
      );
      CREATE TABLE IF NOT EXISTS person_link (
        a_source TEXT, a_id TEXT, b_source TEXT, b_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (a_source, a_id, b_source, b_id)
      );
      CREATE TABLE IF NOT EXISTS observation (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL, source_id TEXT NOT NULL,
        kind TEXT NOT NULL, ts INTEGER NOT NULL,
        status TEXT, text TEXT, place TEXT, meta TEXT,
        dedup TEXT NOT NULL UNIQUE,
        FOREIGN KEY (source, source_id) REFERENCES person(source, source_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS obs_person_ts ON observation(source, source_id, ts);
      CREATE INDEX IF NOT EXISTS obs_kind_ts   ON observation(kind, ts);
      CREATE TABLE IF NOT EXISTS ingest_log (
        id INTEGER PRIMARY KEY, plugin TEXT, version TEXT,
        received_at INTEGER, n_persons INTEGER, n_obs INTEGER, rejected TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  },
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  let current = Number(getMeta('schema_version') ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      setMeta('schema_version', String(v + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function seedSelf() {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO person
       (source, source_id, handle, display_name, first_seen, last_seen)
     VALUES (?, ?, 'me', 'You', ?, ?)`
  ).run(SELF.source, SELF.sourceId, now, now);
}

// ---------------------------------------------------------------------------
// meta / settings
// ---------------------------------------------------------------------------

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

export function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

const SETTINGS_DEFAULTS = { retentionDays: 365, ingestPort: 8477 };

export function getSettings() {
  const rd = getMeta('retentionDays');
  const ip = getMeta('ingestPort');
  let sources = {};
  try {
    sources = JSON.parse(getMeta('sources') ?? '{}');
  } catch {
    sources = {};
  }
  return {
    retentionDays: rd != null ? Number(rd) : SETTINGS_DEFAULTS.retentionDays,
    ingestPort: ip != null ? Number(ip) : SETTINGS_DEFAULTS.ingestPort,
    sources,
  };
}

export function setSettings(patch = {}) {
  if (patch.retentionDays != null) setMeta('retentionDays', Number(patch.retentionDays));
  if (patch.ingestPort != null) setMeta('ingestPort', Number(patch.ingestPort));
  if (patch.sources != null) setMeta('sources', JSON.stringify(patch.sources));
  return getSettings();
}

// ---------------------------------------------------------------------------
// person id helpers  (renderer/IPC use a single "source:sourceId" string)
// ---------------------------------------------------------------------------

export function personId(source, sourceId) {
  return `${source}:${sourceId}`;
}

export function parsePersonId(id) {
  const i = String(id).indexOf(':');
  if (i < 0) throw new Error(`bad person id: ${id}`);
  return { source: id.slice(0, i), sourceId: id.slice(i + 1) };
}

function rowToPerson(r) {
  if (!r) return null;
  return {
    id: personId(r.source, r.source_id),
    source: r.source,
    sourceId: r.source_id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    birthday: r.birthday,
    pronouns: r.pronouns,
    bio: r.bio,
    note: r.note,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

export { rowToPerson };

// ---------------------------------------------------------------------------
// persons
// ---------------------------------------------------------------------------

// Upsert a Person (SPEC §2.1). Incoming NULL/undefined fields never clobber an
// existing value (COALESCE) so a plugin re-scan can't wipe your manual note;
// first_seen is preserved, last_seen advances.
export function upsertPerson(p, ts = Date.now()) {
  const stmt = db.prepare(
    `INSERT INTO person
       (source, source_id, handle, display_name, avatar_url,
        birthday, pronouns, bio, note, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_id) DO UPDATE SET
       handle       = COALESCE(excluded.handle, person.handle),
       display_name = COALESCE(excluded.display_name, person.display_name),
       avatar_url   = COALESCE(excluded.avatar_url, person.avatar_url),
       birthday     = COALESCE(excluded.birthday, person.birthday),
       pronouns     = COALESCE(excluded.pronouns, person.pronouns),
       bio          = COALESCE(excluded.bio, person.bio),
       note         = COALESCE(excluded.note, person.note),
       last_seen    = MAX(person.last_seen, excluded.last_seen)`
  );
  stmt.run(
    p.source,
    p.sourceId,
    p.handle ?? null,
    p.displayName ?? null,
    p.avatarUrl ?? null,
    p.birthday ?? null,
    p.pronouns ?? null,
    p.bio ?? null,
    p.note ?? null,
    ts,
    ts
  );
  if (Array.isArray(p.links)) {
    for (const l of p.links) {
      linkPersons(personId(p.source, p.sourceId), personId(l.source, l.sourceId), ts);
    }
  }
}

export function personExists(source, sourceId) {
  const r = db
    .prepare('SELECT 1 FROM person WHERE source = ? AND source_id = ?')
    .get(source, sourceId);
  return !!r;
}

export function getPerson(id) {
  const { source, sourceId } = parsePersonId(id);
  return rowToPerson(
    db.prepare('SELECT * FROM person WHERE source = ? AND source_id = ?').get(source, sourceId)
  );
}

// filter: { source, q, hasBirthday, includeSelf }
export function listPersons(filter = {}) {
  const where = [];
  const args = [];
  if (!filter.includeSelf) {
    where.push('source != ?');
    args.push(SELF.source);
  }
  if (filter.source) {
    where.push('source = ?');
    args.push(filter.source);
  }
  if (filter.hasBirthday) {
    where.push("birthday IS NOT NULL AND birthday != ''");
  }
  if (filter.q) {
    where.push('(LOWER(display_name) LIKE ? OR LOWER(handle) LIKE ?)');
    const like = `%${String(filter.q).toLowerCase()}%`;
    args.push(like, like);
  }
  const sql =
    'SELECT * FROM person' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY LOWER(COALESCE(display_name, handle, source_id))';
  return db.prepare(sql).all(...args).map(rowToPerson);
}

export function setNote(id, text) {
  const { source, sourceId } = parsePersonId(id);
  db.prepare('UPDATE person SET note = ? WHERE source = ? AND source_id = ?').run(
    text ?? null,
    source,
    sourceId
  );
  return true;
}

// Assert "same human" across platforms (SPEC §2.1). The edge is symmetric and
// transitive; the *cluster* (transitive closure) is derived on read by
// cluster(). Two guards make the model honest:
//   • a person can never be linked to themselves (id === id) — a no-op edge that
//     would only muddy the closure;
//   • the reserved `self` person is NEVER linkable (§2.1) — it is a presence
//     anchor, not a friend identity, and merging it into a cluster would poison
//     that person's timeline and heatmap with the operator's own history.
// Linking two ids that are ALREADY in one cluster is a harmless no-op: the extra
// direct edge (or the IGNOREd duplicate) changes no closure.
export function linkPersons(idA, idB, ts = Date.now()) {
  const a = parsePersonId(idA);
  const b = parsePersonId(idB);
  if (a.source === b.source && a.sourceId === b.sourceId) {
    throw new Error('cannot link a person to themselves');
  }
  if (a.source === SELF.source || b.source === SELF.source) {
    throw new Error('the reserved self person cannot be linked');
  }
  db.prepare(
    `INSERT OR IGNORE INTO person_link (a_source, a_id, b_source, b_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(a.source, a.sourceId, b.source, b.sourceId, ts);
  return true;
}

// Remove ONE asserted edge, in whichever stored orientation ((a,b) or (b,a)) it
// exists. Only that edge — the rest of the cluster survives, because the closure
// is recomputed on the next cluster() call. Unlinking a middle node of a chain
// (A–B–C, unlink B–C) therefore splits it into {A,B} and {C}, as it should.
export function unlinkPersons(idA, idB) {
  const a = parsePersonId(idA);
  const b = parsePersonId(idB);
  db.prepare(
    `DELETE FROM person_link
      WHERE (a_source = ? AND a_id = ? AND b_source = ? AND b_id = ?)
         OR (a_source = ? AND a_id = ? AND b_source = ? AND b_id = ?)`
  ).run(
    a.source, a.sourceId, b.source, b.sourceId,
    b.source, b.sourceId, a.source, a.sourceId
  );
  return true;
}

// The identity CLUSTER of `id`: the transitive closure of person ids reachable
// through person_link, following edges in BOTH stored directions, and INCLUDING
// `id` itself. Pure BFS with a visited set, so a cycle (A–B, B–A, or a longer
// loop) terminates instead of spinning. Returns an array of "source:sourceId"
// strings; order is breadth-first from `id`.
export function cluster(id) {
  const { source: s0, sourceId: i0 } = parsePersonId(id); // validate + normalise
  const start = personId(s0, i0);
  const seen = new Set([start]);
  const queue = [start];
  const stmt = db.prepare(
    `SELECT a_source, a_id, b_source, b_id FROM person_link
      WHERE (a_source = ? AND a_id = ?) OR (b_source = ? AND b_id = ?)`
  );
  while (queue.length) {
    const cur = queue.shift();
    const { source, sourceId } = parsePersonId(cur);
    for (const r of stmt.all(source, sourceId, source, sourceId)) {
      for (const nid of [personId(r.a_source, r.a_id), personId(r.b_source, r.b_id)]) {
        if (!seen.has(nid)) {
          seen.add(nid);
          queue.push(nid);
        }
      }
    }
  }
  return [...seen];
}

export function getLinks(id) {
  const { source, sourceId } = parsePersonId(id);
  return db
    .prepare(
      `SELECT a_source, a_id, b_source, b_id FROM person_link
       WHERE (a_source = ? AND a_id = ?) OR (b_source = ? AND b_id = ?)`
    )
    .all(source, sourceId, source, sourceId);
}

// person_link has no foreign key, so nothing cascades it — every delete path
// clears its own edges or leaves a dangling half-edge behind (which would then
// resurrect as a phantom cluster member the next time someone with the same
// (source, source_id) was ingested). A link is stored in ONE orientation but is
// semantically symmetric, so both orientations must always be matched.
function clearLinksForPerson(source, sourceId) {
  return db
    .prepare(
      `DELETE FROM person_link
       WHERE (a_source = ? AND a_id = ?) OR (b_source = ? AND b_id = ?)`
    )
    .run(source, sourceId, source, sourceId).changes;
}

// The same rule, one platform wide: every edge with EITHER end on `source`.
function clearLinksForSource(source) {
  return db
    .prepare('DELETE FROM person_link WHERE a_source = ? OR b_source = ?')
    .run(source, source).changes;
}

// §0.5 hard delete: observations cascade via ON DELETE CASCADE; link rows
// (no FK) are cleared here so no dangling reference survives.
export function forgetPerson(id) {
  const { source, sourceId } = parsePersonId(id);
  clearLinksForPerson(source, sourceId);
  db.prepare('DELETE FROM person WHERE source = ? AND source_id = ?').run(source, sourceId);
  return true;
}

// How much of the database one platform accounts for — the exact population
// forgetSource() would delete. Read-only by construction: two COUNT(*)s and
// nothing else, so the UI can state real numbers in a confirm without the act
// of asking changing anything (SPEC §0.5: "states exactly how many people and
// observations it will delete BEFORE doing it").
export function countBySource(source) {
  const persons = db
    .prepare('SELECT COUNT(*) AS n FROM person WHERE source = ?')
    .get(source).n;
  const observations = db
    .prepare('SELECT COUNT(*) AS n FROM observation WHERE source = ?')
    .get(source).n;
  return { persons, observations };
}

// §0.5 removal at PLATFORM granularity: every person that came from one source,
// their observations (FK cascade), the link edges that pointed at them, and that
// source's rows in the audit log — in one transaction, so a failure halfway
// leaves the roster exactly as it was.
//
// `plugins` is the set of batch-`plugin` names whose ingest_log rows belong to
// this source; db.js deliberately does not import ingest.js (it is the only
// module that opens SQLite and has no dependencies), so the caller — which does
// have ingest.PLUGIN_SOURCES — passes them in. The default covers the common
// case where the plugin is named after its source.
//
// It does NOT touch credentials: disconnecting a source and deleting what it
// collected are independent operations, on purpose (SPEC §0.5). After this the
// source is still connected and will collect again on its next run.
//
// The reserved `self` person (§2.1) is refused: it is the operator's own
// presence anchor — the "me" axis of the overlap heatmap — not a friend source,
// and deleting it would silently empty every heatmap in the app.
export function forgetSource(source, { plugins = [source] } = {}) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('forgetSource needs a source name');
  }
  if (source === SELF.source) {
    throw new Error(
      'the reserved self person is not a friend source and cannot be removed — ' +
        'it is the "me" axis of the overlap heatmap'
    );
  }
  return tx(() => {
    // Counted inside the transaction, before anything is deleted, so the number
    // reported back is what was actually removed rather than an earlier guess.
    const { persons, observations } = countBySource(source);
    const links = clearLinksForSource(source);
    db.prepare('DELETE FROM person WHERE source = ?').run(source);
    let ingestLogRows = 0;
    const names = Array.from(new Set((plugins ?? []).filter((p) => typeof p === 'string' && p)));
    if (names.length) {
      const stmt = db.prepare('DELETE FROM ingest_log WHERE plugin = ?');
      for (const name of names) ingestLogRows += stmt.run(name).changes;
    }
    return { source, persons, observations, links, ingestLogRows };
  });
}

// ---------------------------------------------------------------------------
// observations
// ---------------------------------------------------------------------------

// SPEC §3 dedup key: (source, sourceId, kind, ts, coalesce(text, place, status)).
export function dedupKey(o) {
  const disc = o.text ?? o.place ?? o.status ?? '';
  return [o.source, o.sourceId, o.kind, o.ts, disc].join('');
}

// Insert an observation idempotently. Returns true if a new row was written,
// false if it was a duplicate (dedup collision) — used for accepted counts.
export function insertObservation(o) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO observation
         (source, source_id, kind, ts, status, text, place, meta, dedup)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      o.source,
      o.sourceId,
      o.kind,
      o.ts,
      o.status ?? null,
      o.text ?? null,
      o.place ?? null,
      o.meta != null ? JSON.stringify(o.meta) : null,
      dedupKey(o)
    );
  return info.changes > 0;
}

export function logIngest({ plugin, version, receivedAt, nPersons, nObs, rejected }) {
  db.prepare(
    `INSERT INTO ingest_log (plugin, version, received_at, n_persons, n_obs, rejected)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(plugin, version, receivedAt, nPersons, nObs, rejected ? JSON.stringify(rejected) : null);
}

// The audit log (SPEC §4 `ingest_log`) is also the ONLY evidence that an
// external emitter — the Vencord bridge, the CLIs — is alive: they never touch
// this process, they just POST batches, and each accepted batch leaves a row.
// So "is my Vencord plugin working?" is answerable as "what is the latest row
// for plugin = vencord-orbit-bridge?".
//
// One grouped pass, window functions instead of a correlated subquery per
// plugin: ROW_NUMBER picks each plugin's most recent row while COUNT/SUM over
// the same partition give the lifetime totals, so the whole summary costs a
// single scan. Rows with a non-null `rejected` were not deliveries and are
// excluded. `plugin` is an optional, BOUND filter — never string-concatenated.
const INGEST_SUMMARY_SQL = `
  SELECT plugin, version, received_at, n_persons, n_obs, deliveries, total_obs
    FROM (
      SELECT plugin, version, received_at, n_persons, n_obs,
             COUNT(*)   OVER (PARTITION BY plugin) AS deliveries,
             SUM(COALESCE(n_obs, 0)) OVER (PARTITION BY plugin) AS total_obs,
             ROW_NUMBER() OVER (PARTITION BY plugin ORDER BY received_at DESC, id DESC) AS rn
        FROM ingest_log
       WHERE rejected IS NULL
         AND (? IS NULL OR plugin = ?)
    )
   WHERE rn = 1
   ORDER BY plugin`;

// → [{ plugin, version, lastReceivedAt, nPersons, nObs, deliveries, totalObs }]
// nPersons/nObs describe the LATEST delivery; deliveries/totalObs are lifetime.
export function ingestLogSummary({ plugin = null } = {}) {
  return db
    .prepare(INGEST_SUMMARY_SQL)
    .all(plugin ?? null, plugin ?? null)
    .map((r) => ({
      plugin: r.plugin,
      version: r.version,
      lastReceivedAt: r.received_at,
      nPersons: r.n_persons ?? 0,
      nObs: r.n_obs ?? 0,
      deliveries: r.deliveries ?? 0,
      totalObs: r.total_obs ?? 0,
    }));
}

// How many people each source currently accounts for, so the UI can say
// "34 Discord people" for an emitter that has no in-process state to ask.
// The reserved `self` person (§2.1) is not a friend and is never counted.
export function personCountsBySource() {
  const rows = db
    .prepare('SELECT source, COUNT(*) AS n FROM person WHERE source != ? GROUP BY source')
    .all(SELF.source);
  const out = {};
  for (const r of rows) out[r.source] = r.n;
  return out;
}

// §0.5 rolling retention prune.
export function pruneOlderThan(ts) {
  const info = db.prepare('DELETE FROM observation WHERE ts < ?').run(ts);
  return info.changes;
}

// ---------------------------------------------------------------------------
// transaction helper (ingest atomicity)
// ---------------------------------------------------------------------------

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
