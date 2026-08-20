// src/main/db.js — the ONLY module that opens the Orbit SQLite database.
// Storage schema is SPEC §4 verbatim. Pure Node (node:sqlite), no electron,
// so db/ingest/digest stay unit-testable without an Electron runtime.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

// Reserved "operator" identity. Self-presence observations (for the overlap
// heatmap's "me" axis) are keyed to this person. It is core-managed and seeded
// on open() so plugins can emit observations about it without upserting it.
export const SELF = Object.freeze({ source: 'self', sourceId: 'me' });

// Default on-disk location (SPEC §4). Tests pass an explicit path instead.
export function defaultDbPath() {
  return join(homedir(), '.config', 'nx-orbit', 'orbit.sqlite3');
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

export function linkPersons(idA, idB, ts = Date.now()) {
  const a = parsePersonId(idA);
  const b = parsePersonId(idB);
  db.prepare(
    `INSERT OR IGNORE INTO person_link (a_source, a_id, b_source, b_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(a.source, a.sourceId, b.source, b.sourceId, ts);
  return true;
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

// §0.5 hard delete: observations cascade via ON DELETE CASCADE; link rows
// (no FK) are cleared here so no dangling reference survives.
export function forgetPerson(id) {
  const { source, sourceId } = parsePersonId(id);
  db.prepare(
    `DELETE FROM person_link
     WHERE (a_source = ? AND a_id = ?) OR (b_source = ? AND b_id = ?)`
  ).run(source, sourceId, source, sourceId);
  db.prepare('DELETE FROM person WHERE source = ? AND source_id = ?').run(source, sourceId);
  return true;
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
