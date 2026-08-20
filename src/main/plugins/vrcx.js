// NX Orbit — VRCX in-process source reader (reference plugin).
//
// Reads the operator's own VRCX database (~/.config/VRCX/VRCX.sqlite3) READ-ONLY
// and emits a Batch (SPEC §3) of first-person friend data only. It never writes
// to VRCX's database, wraps every query in try/catch (VRCX may hold a write
// lock), and re-scans the whole source each run (ingest dedups — idempotent).
//
// See SPEC.md §0 (charter), §2 (record model), §3 (batch envelope), §8 (mapping)
// and docs/PLUGIN_GUIDELINES.md (the five consent rules).

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const meta = { name: "vrcx", version: "1.0.0", source: "vrcx" };

const PLUGIN_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Timestamp normalization
//
// VRChat/VRCX store two kinds of "time" values:
//   - `created_at`: an ISO-8601 string like "2026-08-18T00:22:15.927Z" — this is
//     the actual wall-clock moment the event happened. RELIABLE.
//   - `time`: an INTEGER that in the feed/gamelog tables is a *session duration*
//     in ms (e.g. 12229067 ≈ 3.4h) or empty string "" — NOT an epoch. AMBIGUOUS.
//
// So we prefer parsing `created_at`, and only fall back to `time` if it both
// classifies as a plausible epoch (sec/ms/µs/.NET-ticks) AND lands in a sane
// calendar window. In practice, for these tables, `created_at` always wins.
// ---------------------------------------------------------------------------

const PLAUSIBLE_MIN_MS = Date.UTC(2000, 0, 1); // 946684800000
const PLAUSIBLE_MAX_MS = Date.UTC(2100, 0, 1); // 4102444800000

export function isPlausibleEpochMs(ms) {
  return (
    typeof ms === "number" &&
    Number.isFinite(ms) &&
    ms >= PLAUSIBLE_MIN_MS &&
    ms < PLAUSIBLE_MAX_MS
  );
}

// Classify a raw positive number as an epoch and return epoch-ms, by magnitude:
//   >= 1e17  → .NET ticks (100ns since 0001-01-01)
//   >= 1e14  → microseconds since Unix epoch
//   >= 1e11  → milliseconds since Unix epoch
//   >= 1e8   → seconds since Unix epoch
//   else     → too small to be a modern epoch (likely a duration) → null
export function numToEpochMs(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e17) return Math.round((n - 621355968000000000) / 10000);
  if (n >= 1e14) return Math.round(n / 1000);
  if (n >= 1e11) return Math.round(n);
  if (n >= 1e8) return Math.round(n * 1000);
  return null;
}

// Parse an ISO-8601 string to epoch-ms, or null if unparseable/blank.
export function isoToEpochMs(s) {
  if (typeof s !== "string" || s.trim() === "") return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// Coerce a `time` cell (may be number, numeric string, "", null) to a number.
function coerceNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "bigint") return Number(v);
  return null;
}

// Resolve an event timestamp to epoch-ms. Prefers `created_at`; falls back to a
// `time` value only when it classifies as a plausible calendar epoch. Returns
// null if neither yields a usable timestamp (caller drops the row).
export function toEventMs(createdAt, timeVal) {
  const iso = isoToEpochMs(createdAt);
  if (iso != null && isPlausibleEpochMs(iso)) return iso;

  const n = coerceNum(timeVal);
  if (n != null) {
    const ms = numToEpochMs(n);
    if (ms != null && isPlausibleEpochMs(ms)) return ms;
  }

  // Last resort: an ISO that parsed but fell outside the plausible window is
  // still better than nothing (keeps genuinely old/odd rows).
  if (iso != null) return iso;
  return null;
}

// ---------------------------------------------------------------------------
// The operator's own presence ("me" axis for the overlap heatmap)
//
// The gamelog tables give the operator DURATIONS, not just instants:
//   - gamelog_location.time  — ms spent in that world instance
//   - gamelog_join_leave.time on an OnPlayerLeft row — ms spent in the instance
// Verified against the real database: a location row at 23:14:04 with
// time=99544 lines up exactly with the operator's OnPlayerLeft at
// 23:15:43.544. So `time` is a duration, and each row is a closed session, not
// a moment. We therefore emit a presence PAIR (online at the start, offline at
// the end) per session, giving the heatmap a "me" axis with real duration.
// Emitting only `online` instants — as this reader used to — left the operator
// with zero measurable hours and collapsed the whole grid.
//
// Sessions from both tables are merged into one non-overlapping timeline before
// emission, so the record stream is always a clean alternating open/close.
// ---------------------------------------------------------------------------

// A single VRChat sitting longer than a day is a rolled-over or corrupt `time`
// value, not a session. We refuse such a duration rather than smear the
// operator's presence across days and manufacture overlap (SPEC §0.3).
const MAX_SELF_SESSION_MS = 24 * 60 * 60 * 1000;

// Rebuild `usr_<uuid>` from the per-user table prefix (`usr` + 32 hex chars),
// so operator rows in gamelog_join_leave can be identified even when the
// `configs` lookup didn't yield the id directly.
export function usrIdFromPrefix(prefix) {
  const m = /^usr([0-9a-fA-F]{32})$/.exec(String(prefix ?? ""));
  if (!m) return null;
  const h = m[1];
  return `usr_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Merge [start,end] sessions into a non-overlapping, ascending timeline.
// Only genuinely overlapping or touching sessions are merged — no gap is
// bridged, because bridging would assert presence nobody recorded.
export function mergeSessions(sessions) {
  const sorted = sessions
    .filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// Turn gamelog rows into closed sessions.
//   locRows      : [{ ts, duration }] from gamelog_location, any order
//   leaveRows    : [{ ts, duration }] operator OnPlayerLeft rows (ts = the leave)
// Duration rules, all biased towards dropping rather than inventing:
//   - a positive duration <= MAX_SELF_SESSION_MS is used as-is;
//   - otherwise (absent / zero / absurd) a location row falls back to the gap
//     until the NEXT location row, but only if that gap is itself a plausible
//     session length — a multi-day gap means the game was closed, not that you
//     sat in that world for three days;
//   - if neither yields an end, the row is dropped. We never guess.
export function buildSelfSessions(locRows = [], leaveRows = []) {
  const sessions = [];

  const loc = locRows
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < loc.length; i++) {
    const { ts, duration } = loc[i];
    let end = null;
    if (Number.isFinite(duration) && duration > 0 && duration <= MAX_SELF_SESSION_MS) {
      end = ts + duration;
    } else {
      const next = loc[i + 1];
      if (next && next.ts > ts && next.ts - ts <= MAX_SELF_SESSION_MS) end = next.ts;
    }
    if (end != null) sessions.push([ts, end]);
  }

  // OnPlayerLeft carries the time spent in the instance, so the leave row alone
  // describes a whole closed session: [leave - duration, leave].
  for (const r of leaveRows) {
    if (!Number.isFinite(r.ts)) continue;
    const d = r.duration;
    if (!Number.isFinite(d) || d <= 0 || d > MAX_SELF_SESSION_MS) continue;
    sessions.push([r.ts - d, r.ts]);
  }

  return mergeSessions(sessions);
}

// Map a VRChat status ring value to the SPEC Observation.status enum.
const STATUS_MAP = {
  active: "active",
  "join me": "joinme",
  joinme: "joinme",
  "ask me": "askme",
  askme: "askme",
  busy: "busy",
  offline: "offline",
  online: "online",
};

export function mapStatus(raw) {
  if (typeof raw !== "string") return null;
  return STATUS_MAP[raw.trim().toLowerCase()] ?? null;
}

function nonEmpty(s) {
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function defaultDbPath() {
  return path.join(os.homedir(), ".config", "VRCX", "VRCX.sqlite3");
}

function resolveDbPath(ctx) {
  return (
    ctx?.vrcxDbPath ||
    ctx?.paths?.vrcxDb ||
    defaultDbPath()
  );
}

function tableExists(db, name) {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

// Discover the operator's per-user table prefix from the `configs` table.
// Keys look like `config:friendloginit_usr_<uuid>` (and currentusergroups_...).
// The per-user table prefix is `usr` + uuid with dashes stripped. Pick the
// candidate whose `<prefix>_friend_log_current` table actually exists.
export function discoverPrefix(db) {
  const candidates = [];
  const seen = new Set();
  const push = (usrId) => {
    if (!usrId || seen.has(usrId)) return;
    seen.add(usrId);
    const hex = usrId.replace(/^usr_/, "").replace(/-/g, "");
    candidates.push({ usrId, prefix: "usr" + hex });
  };

  try {
    const rows = db
      .prepare(
        "SELECT key FROM configs WHERE key LIKE 'config:friendloginit_usr_%' " +
          "OR key LIKE 'config:vrcx_currentuser%_usr_%'"
      )
      .all();
    for (const r of rows) {
      const m = String(r.key).match(/(usr_[0-9a-fA-F-]{36})/);
      if (m) push(m[1]);
    }
  } catch {
    /* ignore — fall through to table-scan fallback */
  }

  // Prefer a candidate whose friend_log_current table exists.
  for (const c of candidates) {
    if (tableExists(db, c.prefix + "_friend_log_current")) return c;
  }

  // Fallback: scan sqlite_master for any *_friend_log_current table.
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' " +
          "AND name LIKE 'usr%_friend_log_current' LIMIT 1"
      )
      .get();
    if (row) {
      const prefix = String(row.name).replace(/_friend_log_current$/, "");
      return { usrId: null, prefix };
    }
  } catch {
    /* ignore */
  }

  return candidates[0] || null;
}

// Safe query: returns [] on any error (VRCX may hold a lock / table may be gone).
function safeAll(db, log, label, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    return params.length ? stmt.all(...params) : stmt.all();
  } catch (e) {
    log?.(`vrcx: query "${label}" failed: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// collect() — the scheduled entry point. Returns a Batch (SPEC §3).
// ---------------------------------------------------------------------------

export async function collect(ctx = {}) {
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const dbPath = resolveDbPath(ctx);

  const emptyBatch = () => ({
    plugin: "vrcx",
    version: PLUGIN_VERSION,
    emittedAt: Date.now(),
    persons: [],
    observations: [],
  });

  if (!fs.existsSync(dbPath)) {
    log(`vrcx: database not found at ${dbPath} — emitting empty batch`);
    return emptyBatch();
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    log(`vrcx: could not open ${dbPath} read-only: ${e.message}`);
    return emptyBatch();
  }

  try {
    const found = discoverPrefix(db);
    if (!found) {
      log("vrcx: could not discover operator prefix — emitting empty batch");
      return emptyBatch();
    }
    const P = found.prefix;
    log(`vrcx: operator ${found.usrId ?? "(unknown id)"} prefix ${P}`);

    // ------- Persons: current friends only (the consent boundary) -------
    const persons = new Map(); // sourceId -> Person
    const friendIds = new Set();

    for (const r of safeAll(
      db,
      log,
      "friend_log_current",
      `SELECT user_id, display_name, trust_level FROM ${P}_friend_log_current`
    )) {
      const id = nonEmpty(r.user_id);
      if (!id) continue;
      friendIds.add(id);
      // trust_level has no home in the SPEC Person model — omit it (do not
      // smuggle it through meta; §3 rejects unknown fields).
      persons.set(id, {
        source: "vrcx",
        sourceId: id,
        handle: r.display_name ?? "",
        displayName: r.display_name ?? "",
      });
    }

    // Only observations ABOUT current friends are emitted. Everything below is
    // gated on friendIds.has(user_id).
    const observations = [];
    const emitObs = (o) => {
      if (o.ts == null || !Number.isFinite(o.ts)) return;
      observations.push(o);
    };

    // ------- presence + location: feed_online_offline -------
    for (const r of safeAll(
      db,
      log,
      "feed_online_offline",
      `SELECT created_at, user_id, type, world_name, time
         FROM ${P}_feed_online_offline`
    )) {
      const id = nonEmpty(r.user_id);
      if (!id || !friendIds.has(id)) continue;
      const ts = toEventMs(r.created_at, r.time);
      if (ts == null) continue;
      const world = nonEmpty(r.world_name);

      const type = String(r.type ?? "").toLowerCase();
      const status =
        type === "online" ? "online" : type === "offline" ? "offline" : null;
      if (status) {
        const o = { source: "vrcx", sourceId: id, kind: "presence", status, ts };
        if (world) o.place = world;
        emitObs(o);
      }

      // location: only rows that carry a world name they broadcast to friends.
      if (world) {
        emitObs({
          source: "vrcx",
          sourceId: id,
          kind: "location",
          ts,
          place: world,
        });
      }
    }

    // ------- status: feed_status -------
    for (const r of safeAll(
      db,
      log,
      "feed_status",
      `SELECT created_at, user_id, status, status_description
         FROM ${P}_feed_status`
    )) {
      const id = nonEmpty(r.user_id);
      if (!id || !friendIds.has(id)) continue;
      const ts = toEventMs(r.created_at, null);
      if (ts == null) continue;
      const status = mapStatus(r.status);
      const o = { source: "vrcx", sourceId: id, kind: "status", ts };
      if (status) o.status = status;
      const text = nonEmpty(r.status_description);
      if (text) o.text = text; // verbatim, exactly as they wrote it
      // Emit only if it carries something meaningful.
      if (o.status || o.text) emitObs(o);
    }

    // ------- bio: feed_bio (obs + latest → Person.bio) -------
    const latestBio = new Map(); // id -> {ts, bio}
    for (const r of safeAll(
      db,
      log,
      "feed_bio",
      `SELECT created_at, user_id, bio FROM ${P}_feed_bio`
    )) {
      const id = nonEmpty(r.user_id);
      if (!id || !friendIds.has(id)) continue;
      const ts = toEventMs(r.created_at, null);
      if (ts == null) continue;
      const bio = nonEmpty(r.bio);
      if (bio) {
        emitObs({ source: "vrcx", sourceId: id, kind: "bio", ts, text: bio });
        const prev = latestBio.get(id);
        if (!prev || ts >= prev.ts) latestBio.set(id, { ts, bio });
      }
    }
    for (const [id, { bio }] of latestBio) {
      const p = persons.get(id);
      if (p) p.bio = bio;
    }

    // ------- notes: the operator's OWN private notes (already first-person) -------
    for (const r of safeAll(
      db,
      log,
      "notes",
      `SELECT user_id, note FROM ${P}_notes`
    )) {
      const id = nonEmpty(r.user_id);
      if (!id || !friendIds.has(id)) continue;
      const note = nonEmpty(r.note);
      const p = persons.get(id);
      if (p && note) p.note = note;
    }

    // ------- friend_log_history: roster / nick changes -------
    for (const r of safeAll(
      db,
      log,
      "friend_log_history",
      `SELECT created_at, type, user_id, display_name, previous_display_name
         FROM ${P}_friend_log_history`
    )) {
      const id = nonEmpty(r.user_id);
      if (!id || !friendIds.has(id)) continue;
      const ts = toEventMs(r.created_at, null);
      if (ts == null) continue;
      const type = String(r.type ?? "");
      if (type === "Friend" || type === "Unfriend") {
        emitObs({
          source: "vrcx",
          sourceId: id,
          kind: "friend",
          ts,
          meta: { event: type.toLowerCase() },
        });
      } else if (type === "DisplayName") {
        const name = nonEmpty(r.display_name);
        const o = { source: "vrcx", sourceId: id, kind: "nick", ts };
        if (name) o.text = name;
        const prev = nonEmpty(r.previous_display_name);
        if (prev) o.meta = { previous: prev };
        if (o.text || o.meta) emitObs(o);
      }
      // TrustLevel changes have no SPEC kind — intentionally dropped.
    }

    // ------- operator self presence: gamelog sessions ("me" axis) -------
    // Reserved person (source:"self", sourceId:"me") the core's heatmap keys to.
    // Emitted as online/offline PAIRS so the operator axis has real duration —
    // see the "operator's own presence" note above.
    const locRows = [];
    for (const r of safeAll(
      db,
      log,
      "gamelog_location",
      "SELECT created_at, world_name, time FROM gamelog_location"
    )) {
      // `time` is a duration here, never an epoch, so the event time comes from
      // created_at alone (passing `time` to toEventMs would risk misreading it).
      const ts = toEventMs(r.created_at, null);
      if (ts == null) continue;
      locRows.push({ ts, duration: coerceNum(r.time) });
    }

    // gamelog_join_leave rows describe everyone in your instances; only the
    // operator's OWN rows may be used for the "me" axis (using anyone else's
    // would be both wrong and a §0 violation). We match on the operator's user
    // id, derived from the discovered prefix — never on display name.
    const operatorId = found.usrId ?? usrIdFromPrefix(P);
    const leaveRows = [];
    if (operatorId) {
      for (const r of safeAll(
        db,
        log,
        "gamelog_join_leave",
        "SELECT created_at, type, user_id, time FROM gamelog_join_leave WHERE user_id = ? AND type = 'OnPlayerLeft'",
        [operatorId]
      )) {
        const ts = toEventMs(r.created_at, null);
        if (ts == null) continue;
        leaveRows.push({ ts, duration: coerceNum(r.time) });
      }
    }

    const selfSessions = buildSelfSessions(locRows, leaveRows);
    if (selfSessions.length) {
      persons.set("self:me", {
        source: "self",
        sourceId: "me",
        handle: "you",
        displayName: "(you)",
      });
      for (const [start, end] of selfSessions) {
        // No `place`: a merged session can span several worlds, so there is no
        // single honest answer, and a stable record shape keeps the §3 dedup
        // key identical across re-scans (this reader is idempotent).
        emitObs({ source: "self", sourceId: "me", kind: "presence", status: "online", ts: start });
        emitObs({ source: "self", sourceId: "me", kind: "presence", status: "offline", ts: end });
      }
      log(`vrcx: ${selfSessions.length} operator sessions → ${selfSessions.length * 2} self presence records`);
    }

    const personList = Array.from(persons.values());
    log(
      `vrcx: emitting ${personList.length} persons, ${observations.length} observations`
    );

    return {
      plugin: "vrcx",
      version: PLUGIN_VERSION,
      emittedAt: Date.now(),
      persons: personList,
      observations,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export default { meta, collect };
