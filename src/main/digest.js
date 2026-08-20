// src/main/digest.js — SPEC §5 derivations. Pure SQL + arithmetic shaping.
// No inference, no models: every function is a query over data you already had,
// reduced to counts / histograms / next-date math. Empty DB → zeros/empties.

import * as db from './db.js';

const DAY_MS = 86400000;

// Presence statuses that count as "around" (everything that isn't offline).
const ONLINE = new Set(['online', 'active', 'joinme', 'askme', 'busy']);

function person(source, sourceId) {
  return db.rowToPerson(
    db.getDb().prepare('SELECT * FROM person WHERE source = ? AND source_id = ?').get(source, sourceId)
  );
}

// ===========================================================================
// IDENTITY CLUSTERS — one entry per HUMAN (SPEC §2.1 / §5)
// ===========================================================================
//
// A link is the operator's own assertion that two platform identities are one
// person, and it is symmetric and transitive, so the closure over `person_link`
// is one human. Every "who is around / who is in my roster" derivation therefore
// has to COLLAPSE identities into humans before it shapes anything: a friend you
// linked across Steam, Discord and VRChat is one card, not three, and the count
// beside it counts people, not rows — otherwise linking someone would inflate
// "who's around", which is a lie about how many friends are actually there.
//
// The clustering itself is never a guess (§0.3): it is exactly the edges the
// operator clicked, and nothing else.
//
// PERFORMANCE. All three call sites need the clustering of the WHOLE roster, and
// db.cluster() is a BFS of queries — fine per person, ~800 round trips here. So
// every one of them takes db.clusterIndex() ONCE (a single scan of person_link,
// connected components built in memory with union-find) and reuses it, plus one
// grouped presence scan, plus one primary-key lookup per person actually shown.

// Latest `presence` per IDENTITY for the whole database, in one grouped query —
// → Map<personId, { status, place, ts, online }>. The reserved `self` person is
// excluded here rather than at every call site: it is the operator's own
// presence anchor, never a friend (§2.1).
function latestPresenceByIdentity() {
  const rows = db.getDb().prepare(
    `SELECT o.source, o.source_id, o.status, o.place, o.ts
       FROM observation o
       JOIN (
         SELECT source, source_id, MAX(ts) AS mt
           FROM observation
          WHERE kind = 'presence'
          GROUP BY source, source_id
       ) latest
         ON o.source = latest.source
        AND o.source_id = latest.source_id
        AND o.ts = latest.mt
      WHERE o.kind = 'presence'
        AND o.source != ?`
  ).all(db.SELF.source);

  const out = new Map();
  for (const r of rows) {
    const id = db.personId(r.source, r.source_id);
    const prev = out.get(id);
    // Two rows can share the identity's MAX(ts) — an online and an offline event
    // recorded in the same millisecond. Picking the online one is the only
    // non-arbitrary tie-break: they are demonstrably there.
    if (!prev || (ONLINE.has(r.status) && !prev.online)) {
      out.set(id, { status: r.status, place: r.place, ts: r.ts, online: ONLINE.has(r.status) });
    }
  }
  return out;
}

// THE DISPLAY-FIELD RULE — one rule, every field.
//
// Rank a cluster's identities by how recently the operator actually saw them:
// online ones first, then latest presence `ts`, then `last_seen`, then id (so
// the order is total and cannot flip between refreshes). Then take, PER FIELD,
// the first identity in that order whose value is non-empty.
//
// That single rule covers both halves of what a merged card needs:
//   • displayName / handle / avatarUrl come from the identity you most recently
//     saw them on — the name and face you would actually recognise today;
//   • birthday / pronouns / bio / note survive even when the freshest identity
//     carries none. A `contacts` identity typically holds the birthday while the
//     `steam` one holds the avatar; preferring "whoever has one" is what keeps
//     either from being dropped.
//
// Nothing is merged, blended, concatenated or synthesised: every field on the
// card is ONE identity's value, verbatim. Inventing a composite would be
// inference about a person (§0.3).
const DISPLAY_FIELDS = ['displayName', 'handle', 'avatarUrl', 'birthday', 'pronouns', 'bio', 'note'];

function nonEmpty(v) {
  return v != null && String(v).trim() !== '';
}

// Collapse one cluster's Person rows into a single entry. The result is a strict
// SUPERSET of a Person (same id/source/handle/… keys), so every existing caller
// and every renderer path that expected a Person keeps working; what is new is
// `identities[]` (all of them, each with its own live state) and the primary
// presence lifted from the most recently-seen ONLINE identity.
function collapseCluster(persons, presence) {
  const rows = persons.map((p) => ({ p, pr: presence.get(p.id) || null }));

  // "Most recently active" — see THE DISPLAY-FIELD RULE above.
  const activity = (x) => x.pr?.ts ?? x.p.lastSeen ?? 0;
  const ranked = rows.slice().sort(
    (a, b) =>
      Number(!!b.pr?.online) - Number(!!a.pr?.online) ||
      activity(b) - activity(a) ||
      (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0)
  );

  // A stable primary id for the cluster: the lexicographically smallest member.
  // It never flips between refreshes (so it can key a DOM list), it is a real
  // member id (so people.get / the person sheet accept it), and it does not
  // depend on who happens to be online at this second.
  const primary = rows.reduce((a, b) => (a.p.id <= b.p.id ? a : b));

  const identities = rows.map(({ p, pr }) => ({
    id: p.id,
    source: p.source,
    sourceId: p.sourceId,
    displayName: p.displayName,
    handle: p.handle,
    avatarUrl: p.avatarUrl,
    status: pr ? pr.status : null,
    place: pr ? pr.place : null,
    ts: pr ? pr.ts : null,
    online: !!pr?.online,
  }));
  identities.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const entry = {
    id: primary.p.id,
    source: primary.p.source,
    sourceId: primary.p.sourceId,
    firstSeen: rows.reduce((m, r) => Math.min(m, r.p.firstSeen ?? Infinity), Infinity),
    lastSeen: rows.reduce((m, r) => Math.max(m, r.p.lastSeen ?? 0), 0),
    identities,
  };
  if (!Number.isFinite(entry.firstSeen)) entry.firstSeen = entry.lastSeen;
  for (const f of DISPLAY_FIELDS) {
    const hit = ranked.find((r) => nonEmpty(r.p[f]));
    entry[f] = hit ? hit.p[f] : null;
    // WHICH identity the card is NAMED after. `id` is the stable key (smallest
    // member, never moves); `displayId` is the one whose name and face the card
    // is showing, which is where "open this person" should land — clicking a
    // card that reads "Marlow 🜁" and getting a sheet headed "marlow" looks like
    // the wrong person opened, even though both are the same human.
    if (f === 'displayName') entry.displayId = hit ? hit.p.id : entry.id;
  }

  // The PRIMARY presence: the most recently-seen identity that is online right
  // now. A human is online if ANY identity is (§5) — the card shows all of them,
  // this is just the one the compact views quote.
  const live = rows
    .filter((r) => r.pr?.online)
    .sort((a, b) => b.pr.ts - a.pr.ts || (a.p.id < b.p.id ? -1 : 1))[0];
  entry.online = !!live;
  entry.status = live ? live.pr.status : null;
  entry.place = live ? live.pr.place : null;
  entry.ts = live ? live.pr.ts : entry.lastSeen;
  return entry;
}

// Walk clusters without re-querying a person twice. `seed` supplies rows we
// already have in hand (e.g. the filtered roster), so only the cluster members
// that weren't in the seed cost a primary-key lookup.
function clusterWalker(seed = []) {
  const index = db.clusterIndex();
  const cache = new Map(seed.map((p) => [p.id, p]));
  const done = new Set();
  return {
    // → the cluster's Person rows (self excluded), or null if it was already
    // emitted or holds no surviving person.
    take(id) {
      const members = index.get(id) ?? [id];
      const key = members[0]; // the shared, sorted array → one key per cluster
      if (done.has(key)) return null;
      done.add(key);
      const persons = [];
      for (const mid of members) {
        if (db.parsePersonId(mid).source === db.SELF.source) continue; // never the operator
        let p = cache.get(mid);
        if (p === undefined) {
          p = db.getPerson(mid);
          cache.set(mid, p);
        }
        if (p) persons.push(p);
      }
      return persons.length ? persons : null;
    },
  };
}

// --- whoIsOnNow() — one entry per HUMAN who is online on ANY identity --------
//
// SPEC §5. Latest presence per identity, then collapsed to the identity cluster:
// `identities[]` carries every linked platform with its own status/place/ts, so
// the card can show all the badges and which of them they are on right now; the
// human is online if ANY identity is; and `count` counts humans, not identities.
export function whoIsOnNow() {
  const presence = latestPresenceByIdentity();
  const walker = clusterWalker();
  const people = [];
  for (const [id, pr] of presence) {
    if (!pr.online) continue;
    const persons = walker.take(id);
    if (!persons) continue;
    const entry = collapseCluster(persons, presence);
    if (!entry.online) continue; // a cluster whose only online row was deleted
    people.push(entry);
  }
  people.sort((a, b) => b.ts - a.ts);
  return { count: people.length, people };
}

// --- listPeople(filter) — the roster, collapsed to humans -------------------
//
// The cluster-collapsed view of db.listPersons(): one entry per human, same
// shape as whoIsOnNow()'s entries (a Person superset carrying `identities[]` and
// the live state), so the roster and the "who's around" grid share exactly one
// renderer.
//
// A human MATCHES if any of their identities does, and the entry then carries
// the WHOLE cluster — searching "badger" and getting a card that also shows
// their Steam identity is the point of having linked them. db.listPersons stays
// exactly as it was: the link picker needs individual identities to link
// against, and people.get(id) must keep working with any member id.
export function listPeople(filter = {}) {
  const matched = db.listPersons(filter);
  const presence = latestPresenceByIdentity();
  const walker = clusterWalker(matched);
  const out = [];
  for (const p of matched) {
    const persons = walker.take(p.id);
    if (!persons) continue;
    out.push(collapseCluster(persons, presence));
  }
  // Locale-independent ordering (the host may run any locale), total on id.
  const key = (e) => String(e.displayName ?? e.handle ?? e.sourceId ?? '').toLowerCase();
  out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

// --- overlapHeatmap(personId?) — 7×24 histogram of past overlap -------------
//
// SPEC §5. A `presence` observation is an EVENT ("went online at T"), not a
// state: a friend online 20:00→02:00 emits exactly two rows. Bucketing the raw
// event timestamps would light only the 20:00 and the 02:00 cell and score the
// four hours in between as nothing — the grid would then be measuring "we
// happened to *transition* inside the same weekday-hour", which is coincidence,
// not shared time. So we reconstruct INTERVALS from the open/close events and
// expand each interval across the weekday-hours it actually covers.
//
// THE CELL METRIC — stated here and returned as `metric`, so the UI can label
// it truthfully:
//
//   For ONE friend, cell(weekday, hour) = the number of DISTINCT CALENDAR DATES
//   on which BOTH the operator and that friend were online at some point during
//   that local weekday-hour, inside the retention window. (Max value for a
//   365-day window is therefore ~52 — the number of, say, Tuesdays.)
//
//   For the AGGREGATE view (no personId) it is that per-friend number summed
//   over every friend, i.e. "friend-days of overlap in this hour".
//
// It is plain counting over timestamps you already had. It is a histogram of
// the past and predicts nothing (§0.3).

// The longest stretch of presence a single `online` event is allowed to buy.
//
// A source only observes transitions while the source itself is running. VRCX
// is off while VRChat is off, so a friend who goes online, is missed for a
// week, and is finally noticed offline is recorded as one enormous "session" —
// the real database holds closed intervals up to 224h (9 days). Nobody sat in
// VRChat for nine days: the `offline` was late, not the presence long. The same
// gap appears as a dangling `online` when the closing event is lost outright.
//
// Crediting either at face value would light every cell of that friend's grid
// with overlap that never happened — a §0.3 violation wearing a bug's clothes.
// So this caps EVERY interval, dangling or closed, at 12h from its opening
// event: generous for one real sitting, far shorter than the days-long failure
// mode. It under-counts genuine marathon sessions, and that is the deliberate
// direction of the error — the heatmap may miss hours you were together, but it
// must never claim hours it cannot back up.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

export function overlapHeatmap(personId) {
  const windowDays = db.getSettings().retentionDays;
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const now = Date.now();
  const windowStart = now - windowDays * DAY_MS;
  const metric = 'distinct-dates-both-online';

  // Rows older than (windowStart - MAX_SESSION_MS) cannot open an interval that
  // reaches into the window under any rule we apply, and retention pruning has
  // normally deleted them anyway; excluding them keeps the scan bounded.
  const scanFrom = windowStart - MAX_SESSION_MS;

  // --- the operator's own coverage, built ONCE -------------------------------
  const selfRows = db.getDb().prepare(
    `SELECT ts, status FROM observation
      WHERE kind = 'presence' AND source = ? AND source_id = ? AND ts >= ?
      ORDER BY ts`
  ).all(db.SELF.source, db.SELF.sourceId, scanFrom);

  const selfBuckets = new Set();
  for (const iv of buildIntervals(selfRows, windowStart, now)) addBuckets(iv, selfBuckets);

  let max = 0;
  if (selfBuckets.size === 0) {
    // No "me" axis → nothing to overlap with. Zero grid, not an error.
    return { grid, max, windowDays, metric, selfHours: 0, friendsConsidered: 0 };
  }

  // Overlay one identity-set's distinct online buckets onto the grid: +1 per
  // bucket the operator ALSO covered — each is one date both were online in that
  // weekday-hour.
  const overlay = (buckets) => {
    for (const b of buckets) {
      if (!selfBuckets.has(b)) continue;
      const hour = b % 24;
      const wd = weekdayOfDayNum((b - hour) / 24);
      const v = ++grid[wd][hour];
      if (v > max) max = v;
    }
  };

  let friendsConsidered = 0;

  if (personId) {
    // SINGLE PERSON: the friend side is the whole identity CLUSTER minus `self`
    // (§2.1), so a friend's linked Steam + VRChat presence UNIONS into one grid
    // — a date counts once even if both identities were online that hour.
    // Intervals are still built PER identity (open/close streams must not
    // interleave across sources); their buckets then merge before intersecting
    // with the operator's. This is the ONLY change from the aggregate path: the
    // friend-side identity set went from [one id] to cluster(id) minus self.
    const friendIds = db.cluster(personId).filter(
      (id) => db.parsePersonId(id).source !== db.SELF.source
    );
    const stmt = db.getDb().prepare(
      `SELECT ts, status FROM observation
        WHERE kind = 'presence' AND source = ? AND source_id = ? AND ts >= ?
        ORDER BY ts`
    );
    const buckets = new Set();
    for (const id of friendIds) {
      const { source, sourceId } = db.parsePersonId(id);
      for (const iv of buildIntervals(stmt.all(source, sourceId, scanFrom), windowStart, now)) {
        addBuckets(iv, buckets);
      }
    }
    if (friendIds.length) friendsConsidered = 1; // one human, however many identities
    overlay(buckets);
    return { grid, max, windowDays, metric, selfHours: selfBuckets.size, friendsConsidered };
  }

  // AGGREGATE (no personId): ONE query, streamed and grouped in JS by identity.
  // (The old shape ran a query per friend — 411 of them on the real database.)
  const rows = db.getDb().prepare(
    `SELECT source, source_id, ts, status FROM observation
      WHERE kind = 'presence' AND source != ? AND ts >= ?
      ORDER BY source, source_id, ts`
  ).all(db.SELF.source, scanFrom);

  let group = [];
  let groupKey = null;

  const flush = () => {
    if (!group.length) return;
    friendsConsidered++;
    const buckets = new Set();
    for (const iv of buildIntervals(group, windowStart, now)) addBuckets(iv, buckets);
    overlay(buckets);
    group = [];
  };

  for (const r of rows) {
    const key = r.source + ' ' + r.source_id;
    if (key !== groupKey) {
      flush();
      groupKey = key;
    }
    group.push(r);
  }
  flush();

  return { grid, max, windowDays, metric, selfHours: selfBuckets.size, friendsConsidered };
}

// Reconstruct online intervals from ONE person's presence events (ascending by
// ts) and clip each to [windowStart, windowEnd]. The messy-data rules — every
// one of them chosen to under-count rather than to invent (§0.3):
//
//   • an ONLINE-ish status (online/active/joinme/askme/busy) OPENS an interval;
//     `offline` CLOSES it.
//   • `idle` — and any other or absent status — is neither an open nor a close.
//     Going idle doesn't start a session and doesn't end one, so it is skipped
//     and leaves a running interval running.
//   • CONSECUTIVE OPENS DO NOT STACK: a re-announced "still online" is the same
//     session, so the earliest open wins…
//   • …unless the new open lands more than MAX_SESSION_MS after it, which means
//     the earlier session's close was lost: that one is cut at the cap and the
//     new event starts a fresh interval, so one missing `offline` can never
//     swallow the days that follow it.
//   • a CLOSE WITH NO OPEN is ignored outright. We don't know when that session
//     began, and picking a start would be inference, not arithmetic.
//   • an open with NO CLOSE AT ALL ends at min(now, open + MAX_SESSION_MS).
//   • EVERY interval is truncated to MAX_SESSION_MS regardless of how it ended,
//     for the reason given at that constant.
function buildIntervals(rows, windowStart, windowEnd) {
  const out = [];
  // One place where the cap, the retention window and "no future" are applied,
  // so no rule above can accidentally escape them.
  const push = (start, end) => {
    const a = Math.max(start, windowStart);
    const b = Math.min(end, start + MAX_SESSION_MS, windowEnd);
    if (b > a) out.push([a, b]);
  };

  let open = null;
  for (const r of rows) {
    if (ONLINE.has(r.status)) {
      if (open === null) {
        open = r.ts;
      } else if (r.ts - open > MAX_SESSION_MS) {
        push(open, r.ts); // capped by push() — the lost close ends it there
        open = r.ts;
      }
      // else: the same session, still running — keep the earliest open.
    } else if (r.status === 'offline') {
      if (open === null) continue; // close with no open → ignore
      push(open, r.ts);
      open = null;
    }
    // any other status (idle, null) → not a transition we can read
  }
  if (open !== null) push(open, windowEnd); // dangling open, capped by push()
  return out;
}

// Add every local weekday-hour bucket that [start, end) touches to `set`.
// Buckets are identified by `localDayNum * 24 + localHour`, so a bucket is a
// specific hour on a specific CALENDAR DATE — counting them is counting dates.
//
// DST-safe: we never advance by a blind 3600000ms. Each step moves an hour of
// REAL time and then re-floors to the local hour boundary, so the walk can
// never drift off the local clock — a spring-forward simply has no 02:00
// bucket, and an autumn fall-back re-visits the repeated hour (deduped by the
// Set) instead of skipping it. Blind ms-stepping survives whole-hour shifts by
// luck, but not a zone whose DST shift is 30 minutes: on Lord Howe's April
// transition it drifts to :30 past the hour and silently drops buckets
// (test/digest.test.js pins this in both kinds of zone).
function addBuckets([start, end], set) {
  let d = new Date(start);
  d.setMinutes(0, 0, 0); // floor to the local hour containing `start`
  let t = d.getTime();
  while (t < end) {
    set.add(localDayNum(d) * 24 + d.getHours());
    const next = new Date(t + 3600000);
    next.setMinutes(0, 0, 0);
    const nt = next.getTime() > t ? next.getTime() : t + 3600000;
    d = new Date(nt);
    t = nt;
  }
}

// Calendar date as whole days since the epoch, read off the LOCAL Y/M/D (so it
// is exact across DST, unlike offset arithmetic on the raw timestamp).
function localDayNum(d) {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}
// dayNum * DAY_MS is UTC midnight of that calendar date, so getUTCDay() is that
// date's weekday (0 = Sunday), matching Date#getDay() for the local date.
function weekdayOfDayNum(dayNum) {
  return new Date(dayNum * DAY_MS).getUTCDay();
}

// --- upcomingBirthdays(withinDays=30) ---------------------------------------
export function upcomingBirthdays(withinDays = 30) {
  const rows = db.getDb().prepare(
    `SELECT * FROM person
      WHERE birthday IS NOT NULL AND birthday != '' AND source != ?`
  ).all(db.SELF.source);

  const today = new Date();
  const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const out = [];
  for (const r of rows) {
    const md = parseBirthday(r.birthday);
    if (!md) continue;
    const { month, day } = md;
    let year = today.getFullYear();
    let next = Date.UTC(year, month - 1, day);
    if (next < t0) next = Date.UTC(year + 1, month - 1, day);
    const daysAway = Math.round((next - t0) / DAY_MS);
    if (daysAway <= withinDays) {
      const nd = new Date(next);
      const nextDate = `${nd.getUTCFullYear()}-${pad(nd.getUTCMonth() + 1)}-${pad(nd.getUTCDate())}`;
      out.push({ person: db.rowToPerson(r), nextDate, daysAway });
    }
  }
  out.sort((a, b) => a.daysAway - b.daysAway);
  return out;
}

function parseBirthday(b) {
  // "MM-DD" or "YYYY-MM-DD"
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(String(b).trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

// --- statusBoard() — latest non-empty status text per HUMAN, newest first ---
//
// Cluster-collapsed the same way as whoIsOnNow (§2.1): a friend you have linked
// across Discord and VRChat sets one holiday note, and listing it twice would
// read as two friends being away. The query already returns newest-first, so the
// FIRST row a cluster produces is that human's latest status — every later one
// is the same person's older note on another platform and is skipped. `person`
// is the collapsed entry (a Person superset), so the row still exposes
// person.id / person.displayName exactly as before, and now also identities[].
export function statusBoard() {
  const rows = db.getDb().prepare(
    `SELECT o.source, o.source_id, o.status, o.text, o.ts
       FROM observation o
       JOIN (
         SELECT source, source_id, MAX(ts) AS mt
           FROM observation
          WHERE kind = 'status' AND text IS NOT NULL AND text != ''
          GROUP BY source, source_id
       ) latest
         ON o.source = latest.source
        AND o.source_id = latest.source_id
        AND o.ts = latest.mt
      WHERE o.kind = 'status' AND o.text IS NOT NULL AND o.text != ''
        AND o.source != ?
      ORDER BY o.ts DESC`
  ).all(db.SELF.source);

  const presence = latestPresenceByIdentity();
  const walker = clusterWalker();
  const out = [];
  for (const r of rows) {
    const persons = walker.take(db.personId(r.source, r.source_id));
    if (!persons) continue; // already emitted for this human, or nobody left
    out.push({
      person: collapseCluster(persons, presence),
      // Which identity wrote it — the same text can only mean one thing, but on
      // a merged card it helps to say where they said it.
      source: r.source,
      status: r.status,
      text: r.text,
      ts: r.ts,
    });
  }
  return out;
}

// --- changeFeed(sinceTs?) — bio/nick/avatar/friend, reverse-chron -----------
export function changeFeed(sinceTs = 0) {
  const rows = db.getDb().prepare(
    `SELECT source, source_id, kind, status, text, place, meta, ts
       FROM observation
      WHERE kind IN ('bio','nick','avatar','friend') AND ts > ? AND source != ?
      ORDER BY ts DESC`
  ).all(sinceTs, db.SELF.source);

  return rows.map((r) => ({
    person: person(r.source, r.source_id),
    kind: r.kind,
    status: r.status,
    text: r.text,
    place: r.place,
    meta: r.meta ? safeParse(r.meta) : null,
    ts: r.ts,
  }));
}

// --- personTimeline(personId) — one friend's observations, reverse-chron ----
//
// SPEC §5/§2.1: unioned across the linked identity CLUSTER, so a person you have
// linked shows ONE merged history across Steam, Discord and VRChat. Every row is
// tagged with the `source` it came from, so the UI can print a per-source badge
// on each entry. cluster() is closed over person_link and never reaches `self`
// (self is unlinkable), so no operator presence leaks into a friend's timeline.
export function personTimeline(personId) {
  const stmt = db.getDb().prepare(
    `SELECT source, source_id, kind, status, text, place, meta, ts
       FROM observation
      WHERE source = ? AND source_id = ?`
  );
  const rows = [];
  for (const id of db.cluster(personId)) {
    const { source, sourceId } = db.parsePersonId(id);
    for (const r of stmt.all(source, sourceId)) rows.push(r);
  }
  rows.sort((a, b) => b.ts - a.ts);

  return rows.map((r) => ({
    source: r.source,
    kind: r.kind,
    status: r.status,
    text: r.text,
    place: r.place,
    meta: r.meta ? safeParse(r.meta) : null,
    ts: r.ts,
  }));
}

// Normalised match key for link suggestions (SPEC §2.1): lowercase, NFKD, strip
// combining marks and every non-alphanumeric, so "Badger", "badger_", "bÁdger"
// and "ＢＡＤＧＥＲ" fold to the same "badger". Same recipe as the renderer's
// `fold` and the mock's `sortKey`, kept local so digest has no UI dependency.
function normKey(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

// Ignore matches on keys this short — "a"/"ka"/"jo" collide constantly and would
// bury the real signal. Three folded alphanumerics is enough to mean something.
const MIN_KEY = 3;

// Compare two Person objects by normalized handle/displayName and return the
// STRONGEST relationship, or null. Ranking (SPEC §2.1):
//   3 — exact normalized handle match      ("same handle: badger")
//   2 — exact normalized displayName match ("same name: Noctis")
//   1 — one key is a prefix/substring of the other, on any handle/name pairing
//       ("name Noctis ~ Noctis9")
// Pure string comparison. It concludes nothing; it only proposes.
function bestMatch(a, b) {
  const ah = normKey(a.handle);
  const an = normKey(a.displayName);
  const bh = normKey(b.handle);
  const bn = normKey(b.displayName);

  if (ah.length >= MIN_KEY && ah === bh) {
    return { score: 3, reason: `same handle: ${a.handle || ah}` };
  }
  if (an.length >= MIN_KEY && an === bn) {
    return { score: 2, reason: `same name: ${a.displayName || an}` };
  }
  const aKeys = [ah, an].filter((k) => k.length >= MIN_KEY);
  const bKeys = [bh, bn].filter((k) => k.length >= MIN_KEY);
  for (const ak of aKeys) {
    for (const bk of bKeys) {
      if (ak === bk || ak.includes(bk) || bk.includes(ak)) {
        const al = a.displayName || a.handle || ah;
        const bl = b.displayName || b.handle || bh;
        return { score: 1, reason: `name ${al} ~ ${bl}` };
      }
    }
  }
  return null;
}

// --- linkSuggestions(personId?) — candidate same-humans to CONFIRM ----------
//
// SPEC §5/§2.1. For one person: identities on a DIFFERENT source, NOT already in
// the person's cluster, NOT the self person, whose normalized handle/name is
// similar — scored and reason-tagged. Across the whole roster (no personId):
// the strongest cross-source pairs, de-duplicated ((a,b) never also (b,a)) and
// capped. This is PURE STRING COMPARISON and applies NOTHING — no link is ever
// written here (charter §0.3). Shape: [{ a, b, person, candidate, score, reason }].
export function linkSuggestions(personId) {
  const roster = db.listPersons({}); // excludes the self person by default

  if (personId) {
    const base = db.getPerson(personId);
    if (!base || base.source === db.SELF.source) return [];
    const inCluster = new Set(db.cluster(personId));
    const out = [];
    for (const c of roster) {
      if (c.source === base.source) continue; // must be a DIFFERENT source
      if (inCluster.has(c.id)) continue; // already the same human
      const m = bestMatch(base, c);
      if (!m) continue;
      out.push({ a: base.id, b: c.id, person: base, candidate: c, score: m.score, reason: m.reason });
    }
    out.sort((x, y) => y.score - x.score || (x.candidate.id < y.candidate.id ? -1 : 1));
    return out;
  }

  // Roster-wide: every cross-source pair, best match, de-duplicated and capped.
  const out = [];
  const seen = new Set();
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const p = roster[i];
      const q = roster[j];
      if (p.source === q.source) continue;
      const m = bestMatch(p, q);
      if (!m) continue;
      if (db.cluster(p.id).includes(q.id)) continue; // already one human
      const key = p.id < q.id ? `${p.id} ${q.id}` : `${q.id} ${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a: p.id, b: q.id, person: p, candidate: q, score: m.score, reason: m.reason });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 50);
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
