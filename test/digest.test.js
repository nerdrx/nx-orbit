// Digest derivations against a seeded temp DB (SPEC §5).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/main/db.js';
import * as digest from '../src/main/digest.js';
import { freshDb } from './helpers.js';

let ctx;
beforeEach(() => {
  ctx = freshDb();
});
afterEach(() => ctx.cleanup());

function seedFriend(sourceId, over = {}) {
  db.upsertPerson({ source: 'vrcx', sourceId, displayName: 'F-' + sourceId, ...over });
}
function presence(sourceId, status, ts) {
  db.insertObservation({ source: 'vrcx', sourceId, kind: 'presence', status, ts });
}
function selfPresence(ts) {
  db.insertObservation({ source: 'self', sourceId: 'me', kind: 'presence', status: 'online', ts });
}

// --- whoIsOnNow --------------------------------------------------------------
test('whoIsOnNow: only people whose latest presence is online, self excluded', () => {
  seedFriend('a');
  seedFriend('b');
  presence('a', 'offline', 100);
  presence('a', 'online', 200); // a latest = online
  presence('b', 'online', 100);
  presence('b', 'offline', 200); // b latest = offline
  selfPresence(300); // self is online but must not appear

  const r = digest.whoIsOnNow();
  assert.equal(r.count, 1);
  assert.equal(r.people.length, 1);
  assert.equal(r.people[0].sourceId, 'a');
  assert.ok(!r.people.some((p) => p.source === 'self'));
});

test('whoIsOnNow: empty DB returns zero', () => {
  const r = digest.whoIsOnNow();
  assert.deepEqual(r, { count: 0, people: [] });
});

// --- overlapHeatmap ----------------------------------------------------------
// `presence` is an EVENT stream ("went online at T"), so the heatmap has to
// read it as INTERVALS: a friend online 20:00→02:00 must light six hours, not
// the two hours they happened to transition in. Every case below anchors on
// `now` rather than a hard-coded calendar date, so the suite can't quietly rot
// out of the retention window a year from now.

const HOUR = 3600000;

// A local wall-clock moment `daysAgo` days back, at hour:minute.
function at(daysAgo, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
function session(sourceId, start, end) {
  presence(sourceId, 'online', start);
  presence(sourceId, 'offline', end);
}
function selfSession(start, end) {
  db.insertObservation({ source: 'self', sourceId: 'me', kind: 'presence', status: 'online', ts: start });
  db.insertObservation({ source: 'self', sourceId: 'me', kind: 'presence', status: 'offline', ts: end });
}
// A presence session for a DISCORD identity (the cluster tests link a vrcx and a
// discord identity as one human; the vrcx-only `session` helper can't seed b).
function discordSession(sourceId, start, end) {
  db.insertObservation({ source: 'discord', sourceId, kind: 'presence', status: 'online', ts: start });
  db.insertObservation({ source: 'discord', sourceId, kind: 'presence', status: 'offline', ts: end });
}

// Independent oracle for "which cells should this interval light": sample every
// minute of real time and collect the distinct (local date, local hour) it
// lands in. Deliberately a different algorithm from digest.js's hour-boundary
// walk, so the two can't share a bug — and it is inherently DST-correct,
// because it never assumes an hour is 3600000ms of local clock.
function expectedCells(start, end) {
  const dateHours = new Set();
  for (let t = start; t < end; t += 60000) {
    const d = new Date(t);
    dateHours.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getDay()}`);
  }
  const cells = new Map(); // "weekday:hour" -> distinct dates
  for (const k of dateHours) {
    const p = k.split('-');
    const cell = `${p[4]}:${p[3]}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
  }
  return cells;
}
// Assert the grid holds exactly `cells` and nothing else. Returns the total.
function assertGrid(grid, cells) {
  let total = 0;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const want = cells.get(`${d}:${h}`) ?? 0;
      assert.equal(grid[d][h], want, `cell weekday ${d} hour ${h}`);
      total += want;
    }
  }
  return total;
}

test('overlapHeatmap: lights every hour an interval covers, not just its endpoints', () => {
  seedFriend('a');
  selfSession(at(3, 8), at(3, 18)); // self around 08:00–18:00
  session('a', at(3, 10), at(3, 13)); // friend around 10:00–13:00

  const r = digest.overlapHeatmap('vrcx:a');
  const total = assertGrid(r.grid, expectedCells(at(3, 10), at(3, 13)));
  assert.equal(total, 3, 'hours 10, 11 and 12 — the whole interval');
  assert.equal(r.max, 1);
  assert.equal(r.windowDays, 365);
  // The metric is returned so the UI can label the number truthfully.
  assert.equal(r.metric, 'distinct-dates-both-online');
  assert.equal(r.friendsConsidered, 1);
  assert.ok(r.selfHours > 0);
});

test('overlapHeatmap: an interval crossing midnight lights both weekdays', () => {
  seedFriend('a');
  selfSession(at(3, 20), at(2, 6)); // self 20:00 → 06:00 next day
  session('a', at(3, 22), at(2, 2)); // friend 22:00 → 02:00 next day

  const r = digest.overlapHeatmap('vrcx:a');
  const total = assertGrid(r.grid, expectedCells(at(3, 22), at(2, 2)));
  assert.equal(total, 4, 'hours 22, 23 on one weekday and 00, 01 on the next');

  const wd1 = new Date(at(3, 22)).getDay();
  const wd2 = new Date(at(2, 1)).getDay();
  assert.notEqual(wd1, wd2);
  assert.equal(r.grid[wd1][22], 1);
  assert.equal(r.grid[wd1][23], 1);
  assert.equal(r.grid[wd2][0], 1);
  assert.equal(r.grid[wd2][1], 1);
});

test('overlapHeatmap: a dangling open is capped and never smears into later days', () => {
  seedFriend('a');
  // Self is around for every hour of both days (sessions kept under the cap).
  selfSession(at(5, 0), at(5, 10, 59));
  selfSession(at(5, 11), at(5, 21, 59));
  selfSession(at(5, 22), at(4, 8, 59));
  selfSession(at(4, 9), at(4, 19, 59));
  selfSession(at(4, 20), at(3, 6, 59));
  // Friend goes online and is never seen again — no closing event at all.
  presence('a', 'online', at(5, 9));

  const r = digest.overlapHeatmap('vrcx:a');
  const total = assertGrid(r.grid, expectedCells(at(5, 9), at(5, 9) + 12 * HOUR));
  assert.equal(total, 12, 'exactly MAX_SESSION_MS worth of hours, no more');
  // The following day is fully covered by self, yet gets nothing from the
  // friend: one lost event must not manufacture a second day of overlap.
  const nextDay = new Date(at(4, 12)).getDay();
  assert.equal(r.grid[nextDay].reduce((s, n) => s + n, 0), 0);
});

test('overlapHeatmap: a marathon interval is capped, not spread over every day', () => {
  seedFriend('a');
  // Self is only around three days after the friend's `online`.
  selfSession(at(3, 10), at(3, 18));
  // A friend "online" for four straight days — in practice a missed `offline`,
  // not a person who never stood up. Uncapped it would blanket the whole grid
  // and overlap self on day 3; capped it reaches nowhere near.
  session('a', at(6, 10), at(2, 10));

  const r = digest.overlapHeatmap('vrcx:a');
  assert.equal(r.max, 0);
  assert.equal(r.grid.flat().reduce((s, n) => s + n, 0), 0);
});

test('overlapHeatmap: a close with no preceding open is ignored', () => {
  seedFriend('a');
  seedFriend('b');
  selfSession(at(3, 8), at(3, 18));
  // `a` has only a close — we don't know when it began, so it contributes zero.
  presence('a', 'offline', at(3, 12));
  // `b` has a stray close first, then a real session: only the session counts.
  presence('b', 'offline', at(3, 10));
  session('b', at(3, 12), at(3, 14));

  assert.equal(digest.overlapHeatmap('vrcx:a').grid.flat().reduce((s, n) => s + n, 0), 0);
  const rb = digest.overlapHeatmap('vrcx:b');
  assert.equal(assertGrid(rb.grid, expectedCells(at(3, 12), at(3, 14))), 2);
});

test('overlapHeatmap: consecutive opens do not stack into extra sessions', () => {
  seedFriend('a');
  selfSession(at(3, 8), at(3, 18));
  // Three "still online" announcements, one close: one interval, 09:00–12:00.
  presence('a', 'online', at(3, 9));
  presence('a', 'online', at(3, 10));
  presence('a', 'online', at(3, 11));
  presence('a', 'offline', at(3, 12));

  const r = digest.overlapHeatmap('vrcx:a');
  assert.equal(assertGrid(r.grid, expectedCells(at(3, 9), at(3, 12))), 3);
  assert.equal(r.max, 1, 'the same hour is never counted twice for one date');
});

test('overlapHeatmap: idle neither opens nor closes an interval', () => {
  seedFriend('a');
  seedFriend('b');
  selfSession(at(3, 8), at(3, 18));
  // `a` goes idle mid-session: still the same interval, 09:00–12:00.
  presence('a', 'online', at(3, 9));
  presence('a', 'idle', at(3, 10));
  presence('a', 'offline', at(3, 12));
  // `b` is only ever idle: idle alone is not evidence of being around.
  presence('b', 'idle', at(3, 9));

  assert.equal(assertGrid(digest.overlapHeatmap('vrcx:a').grid, expectedCells(at(3, 9), at(3, 12))), 3);
  assert.equal(digest.overlapHeatmap('vrcx:b').grid.flat().reduce((s, n) => s + n, 0), 0);
});

test('overlapHeatmap: a friend online while self is offline contributes nothing', () => {
  seedFriend('a');
  selfSession(at(3, 8), at(3, 10));
  session('a', at(3, 14), at(3, 16)); // no shared hour at all

  const r = digest.overlapHeatmap('vrcx:a');
  assert.equal(r.max, 0);
  assert.equal(r.grid.flat().reduce((s, n) => s + n, 0), 0);
  assert.ok(r.selfHours > 0, 'self was around — just not at the same time');
});

test('overlapHeatmap: no self presence at all → zero grid, no throw', () => {
  seedFriend('a');
  session('a', at(3, 10), at(3, 16));
  const r = digest.overlapHeatmap('vrcx:a');
  assert.equal(r.max, 0);
  assert.equal(r.selfHours, 0);
  assert.equal(r.grid.flat().reduce((s, n) => s + n, 0), 0);
});

test('overlapHeatmap: the same hour on different dates counts once per date', () => {
  seedFriend('a');
  selfSession(at(4, 10), at(4, 12));
  selfSession(at(3, 10), at(3, 12));
  session('a', at(4, 10), at(4, 12));
  session('a', at(3, 10), at(3, 12));

  const r = digest.overlapHeatmap('vrcx:a');
  const wd4 = new Date(at(4, 10)).getDay();
  const wd3 = new Date(at(3, 10)).getDay();
  assert.notEqual(wd4, wd3);
  assert.equal(r.grid[wd4][10], 1);
  assert.equal(r.grid[wd3][10], 1);
  assert.equal(r.grid.flat().reduce((s, n) => s + n, 0), 4);
});

test('overlapHeatmap: aggregate equals the sum of the per-friend grids', () => {
  seedFriend('a');
  seedFriend('b');
  seedFriend('c');
  selfSession(at(3, 8), at(3, 18));
  selfSession(at(4, 8), at(4, 18));
  session('a', at(3, 9), at(3, 13));
  session('b', at(3, 11), at(3, 17));
  session('b', at(4, 9), at(4, 12));
  session('c', at(4, 20), at(4, 22)); // outside self's hours → contributes 0

  const agg = digest.overlapHeatmap();
  const sum = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const id of ['vrcx:a', 'vrcx:b', 'vrcx:c']) {
    const g = digest.overlapHeatmap(id).grid;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) sum[d][h] += g[d][h];
  }
  assert.deepEqual(agg.grid, sum);
  assert.equal(agg.friendsConsidered, 3);
  assert.equal(agg.max, Math.max(...sum.flat()));
  // and the overlapping hours really do stack across friends
  const wd = new Date(at(3, 12)).getDay();
  assert.equal(agg.grid[wd][12], 2, 'a and b were both around at 12:00');
});

test('overlapHeatmap: empty DB returns a zero grid without throwing', () => {
  const r = digest.overlapHeatmap();
  assert.equal(r.max, 0);
  assert.equal(r.selfHours, 0);
  assert.equal(r.friendsConsidered, 0);
  assert.equal(r.grid.length, 7);
  assert.ok(r.grid.every((row) => row.length === 24 && row.every((n) => n === 0)));
  // an unknown person is a zero grid too, not an exception
  assert.equal(digest.overlapHeatmap('vrcx:nobody').max, 0);
});

// DST is the quiet killer here: bucketing an interval by advancing a blind
// 3600000ms can drop or shift buckets around a transition and rotate the grid.
// Europe/Berlin is the whole-hour case; Australia/Lord_Howe shifts by THIRTY
// minutes, which is where a blind stepper measurably breaks — over the same
// matrix of intervals below it silently loses buckets (e.g. a 00:00–03:00
// interval on the April transition comes out as hours 0 and 1, with hour 2
// missing). Every interval is checked against the independent minute-sampled
// oracle, so alignment is pinned for the whole transition day.
for (const tz of ['Europe/Berlin', 'Australia/Lord_Howe']) {
  test(`overlapHeatmap: buckets follow the local clock across a DST shift (${tz})`, () => {
    const prevTz = process.env.TZ;
    process.env.TZ = tz;
    try {
      // The most recent DST transition inside the retention window.
      let day = null;
      for (let i = 2; i < 360 && !day; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        d.setHours(12, 0, 0, 0);
        const prev = new Date(d);
        prev.setDate(prev.getDate() - 1);
        if (d.getTimezoneOffset() !== prev.getTimezoneOffset()) day = d;
      }
      assert.ok(day, `${tz} should have a DST transition in the last year`);

      seedFriend('a');
      let checked = 0;
      for (let startHour = 0; startHour < 24; startHour++) {
        for (const hours of [2, 3, 5]) {
          db.getDb().exec('DELETE FROM observation'); // one scenario at a time
          const st = new Date(day);
          st.setHours(startHour, 0, 0, 0);
          const s = st.getTime();
          const e = s + hours * HOUR; // real time, straddling the shift
          selfSession(s, e);
          session('a', s, e);

          const expected = expectedCells(s, e);
          const total = assertGrid(digest.overlapHeatmap('vrcx:a').grid, expected);
          assert.equal(total, expected.size, `${startHour}:00 +${hours}h`);
          assert.ok(total > 0);
          checked++;
        }
      }
      assert.equal(checked, 72);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });
}

// --- upcomingBirthdays -------------------------------------------------------
test('upcomingBirthdays: within window, sorted by soonest', () => {
  const today = new Date();
  const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const md = (n) => {
    const d = new Date(t0 + n * 86400000);
    return String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  };
  seedFriend('soon', { birthday: md(5) });
  seedFriend('later', { birthday: md(10) });
  seedFriend('faraway', { birthday: md(40) }); // outside default 30
  seedFriend('nobday'); // no birthday

  const list = digest.upcomingBirthdays(30);
  assert.deepEqual(list.map((b) => b.person.sourceId), ['soon', 'later']);
  assert.equal(list[0].daysAway, 5);
  assert.equal(list[1].daysAway, 10);
  assert.match(list[0].nextDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('upcomingBirthdays: empty when nobody has a birthday', () => {
  seedFriend('a');
  assert.deepEqual(digest.upcomingBirthdays(), []);
});

// --- statusBoard -------------------------------------------------------------
test('statusBoard: latest non-empty status text per friend, verbatim', () => {
  seedFriend('a');
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'status', text: 'older', ts: 100 });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'status', text: '🏖 away till the 20th', ts: 200 });

  const board = digest.statusBoard();
  assert.equal(board.length, 1);
  assert.equal(board[0].person.sourceId, 'a');
  assert.equal(board[0].text, '🏖 away till the 20th'); // verbatim, newest
  assert.equal(board[0].ts, 200);
});

test('statusBoard: ignores empty status text and empty DB', () => {
  seedFriend('a');
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'status', text: '', ts: 100 });
  assert.deepEqual(digest.statusBoard(), []);
});

// --- changeFeed / personTimeline --------------------------------------------
test('changeFeed: merges bio/nick/avatar/friend reverse-chron, honours sinceTs', () => {
  seedFriend('a');
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'nick', text: 'NewName', ts: 100 });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'bio', text: 'new bio', ts: 300 });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'presence', status: 'online', ts: 250 });

  const feed = digest.changeFeed(0);
  assert.equal(feed.length, 2); // presence is not a change-feed kind
  assert.equal(feed[0].kind, 'bio'); // newest first
  assert.equal(feed[1].kind, 'nick');

  const since = digest.changeFeed(200);
  assert.equal(since.length, 1);
  assert.equal(since[0].kind, 'bio');
});

test('personTimeline: one friend, reverse-chron, parses meta', () => {
  seedFriend('a');
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'nick', text: 'B', meta: { previous: 'A' }, ts: 100 });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'presence', status: 'online', ts: 200 });

  const tl = digest.personTimeline('vrcx:a');
  assert.equal(tl.length, 2);
  assert.equal(tl[0].ts, 200);
  assert.deepEqual(tl[1].meta, { previous: 'A' });
});

// --- linked-cluster derivations (SPEC §2.1 / §5) ----------------------------
test('personTimeline: unions a linked cluster and tags each row with its source', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'B' });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'presence', status: 'online', ts: 100 });
  db.insertObservation({ source: 'discord', sourceId: 'b', kind: 'presence', status: 'online', ts: 300 });
  db.insertObservation({ source: 'discord', sourceId: 'b', kind: 'bio', text: 'hi', ts: 200 });

  // Before linking: only A's own row.
  assert.equal(digest.personTimeline('vrcx:a').length, 1);

  db.linkPersons('vrcx:a', 'discord:b');
  const tl = digest.personTimeline('vrcx:a');
  assert.equal(tl.length, 3);
  assert.deepEqual(tl.map((e) => e.ts), [300, 200, 100]); // merged, reverse-chron
  assert.equal(tl[0].source, 'discord'); // per-source tag present
  assert.equal(tl[2].source, 'vrcx');
});

test('overlapHeatmap(single): a linked cluster combines both identities’ presence', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'B' });

  // Self is online across a wide window on a single day.
  selfSession(at(3, 8), at(3, 20));
  // A alone covers 10:00-13:00; B (a DIFFERENT source) covers 14:00-17:00. Self
  // covers both, so linking A+B should union their overlap into one grid.
  session('a', at(3, 10), at(3, 13)); // hours 10,11,12
  discordSession('b', at(3, 14), at(3, 17)); // hours 14,15,16

  const only = digest.overlapHeatmap('vrcx:a');
  const aTotal = only.grid.flat().reduce((s, v) => s + v, 0);
  assert.equal(aTotal, 3); // A alone: 3 overlapping hours

  db.linkPersons('vrcx:a', 'discord:b');
  const merged = digest.overlapHeatmap('vrcx:a');
  const mergedTotal = merged.grid.flat().reduce((s, v) => s + v, 0);
  assert.equal(mergedTotal, 6); // union of both identities' hours (3 + 3)
  assert.ok(mergedTotal >= aTotal, 'union is at least each part');
  assert.equal(merged.friendsConsidered, 1); // still ONE human
});

test('overlapHeatmap(single): overlapping identity hours count a date only once', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'B' });
  selfSession(at(3, 8), at(3, 20));
  session('a', at(3, 10), at(3, 13)); // 10,11,12
  discordSession('b', at(3, 11), at(3, 14)); // 11,12,13 — overlaps A on 11,12
  db.linkPersons('vrcx:a', 'discord:b');
  const merged = digest.overlapHeatmap('vrcx:a');
  const total = merged.grid.flat().reduce((s, v) => s + v, 0);
  assert.equal(total, 4); // union {10,11,12,13}, each date-hour once
  assert.equal(merged.max, 1); // no cell double-counted
});

// --- linkSuggestions (pure string comparison, applies NOTHING) --------------
function linkCount() {
  return db.getDb().prepare('SELECT COUNT(*) c FROM person_link').get().c;
}

test('linkSuggestions: finds an exact cross-source handle match', () => {
  db.upsertPerson({ source: 'steam', sourceId: 'a', handle: 'badger', displayName: 'Badger' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', handle: 'badger', displayName: 'badger_' });

  const s = digest.linkSuggestions('steam:a');
  assert.equal(s.length, 1);
  assert.equal(s[0].a, 'steam:a');
  assert.equal(s[0].b, 'discord:b');
  assert.equal(s[0].score, 3);
  assert.match(s[0].reason, /same handle/);
  assert.equal(s[0].person.id, 'steam:a');
  assert.equal(s[0].candidate.id, 'discord:b');
});

test('linkSuggestions: ranks an exact handle match above a mere substring match', () => {
  db.upsertPerson({ source: 'steam', sourceId: 'a', handle: 'badger', displayName: 'Badger' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', handle: 'badger', displayName: 'badger_' }); // exact handle
  db.upsertPerson({ source: 'vrcx', sourceId: 'c', handle: 'badgerVR', displayName: 'Badger Set' }); // substring

  const s = digest.linkSuggestions('steam:a');
  assert.equal(s.length, 2);
  assert.equal(s[0].b, 'discord:b'); // exact first
  assert.ok(s[0].score > s[1].score);
  assert.equal(s[1].b, 'vrcx:c');
});

test('linkSuggestions: excludes same-source, already-clustered, and self', () => {
  db.upsertPerson({ source: 'steam', sourceId: 'a', handle: 'badger', displayName: 'Badger' });
  db.upsertPerson({ source: 'steam', sourceId: 'a2', handle: 'badger', displayName: 'Badger' }); // SAME source
  db.upsertPerson({ source: 'discord', sourceId: 'b', handle: 'badger', displayName: 'Badger' });
  // Give the self person a colliding handle to prove self is never a candidate.
  db.getDb().prepare("UPDATE person SET handle='badger', display_name='Badger' WHERE source='self'").run();

  let s = digest.linkSuggestions('steam:a');
  assert.deepEqual(s.map((x) => x.b).sort(), ['discord:b']); // not steam:a2, not self:me

  db.linkPersons('steam:a', 'discord:b'); // now already one human
  s = digest.linkSuggestions('steam:a');
  assert.equal(s.length, 0); // clustered → no longer suggested
});

test('linkSuggestions: is pure — the link count is unchanged after calling it', () => {
  db.upsertPerson({ source: 'steam', sourceId: 'a', handle: 'badger', displayName: 'Badger' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', handle: 'badger', displayName: 'Badger' });
  const before = linkCount();
  digest.linkSuggestions('steam:a');
  digest.linkSuggestions(); // roster-wide too
  assert.equal(linkCount(), before);
});

test('linkSuggestions: roster-wide de-dups and is cross-source only', () => {
  db.upsertPerson({ source: 'steam', sourceId: 'a', handle: 'badger', displayName: 'Badger' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', handle: 'badger', displayName: 'Badger' });
  const s = digest.linkSuggestions();
  assert.equal(s.length, 1); // (a,b) once, never also (b,a)
  assert.notEqual(s[0].person.source, s[0].candidate.source);
});

// =============================================================================
// IDENTITY CLUSTERS — one card per HUMAN (SPEC §2.1, §5)
//
// Links are the operator's own assertion, symmetric and transitive, so the
// closure over person_link is one person. Every "who is around / who is in my
// roster" derivation collapses to that: a friend linked across Steam, Discord
// and VRChat is ONE entry carrying identities[], not three entries — and the
// count beside them counts humans, because linking someone must never inflate
// how many friends are actually there.
// =============================================================================

// A person on an arbitrary source (seedFriend is vrcx-only), with control over
// last_seen so the display-field ranking is deterministic rather than clock-y.
function seedOn(source, sourceId, over = {}, lastSeen = 1000) {
  db.upsertPerson({ source, sourceId, displayName: `${source}-${sourceId}`, ...over }, lastSeen);
}
function presenceOn(source, sourceId, status, ts, place = null) {
  db.insertObservation({ source, sourceId, kind: 'presence', status, ts, place });
}
const idsOf = (entry) => entry.identities.map((i) => i.id).sort();

test('whoIsOnNow: a linked trio is ONE entry with three identities, online if ANY is', () => {
  seedOn('steam', 'm', { handle: 'marlow' });
  seedOn('vrcx', 'm', { handle: 'marlowVR' });
  seedOn('discord', 'm', { handle: 'marlow' });
  db.linkPersons('steam:m', 'vrcx:m');
  db.linkPersons('vrcx:m', 'discord:m'); // transitive — steam and discord share no edge

  presenceOn('steam', 'm', 'offline', 500);
  presenceOn('vrcx', 'm', 'online', 900, 'The Velvet Moth');
  presenceOn('discord', 'm', 'offline', 700);

  const r = digest.whoIsOnNow();
  assert.equal(r.count, 1, 'one human, not three identities');
  assert.equal(r.people.length, 1);

  const e = r.people[0];
  assert.equal(e.online, true, 'online because ONE identity is');
  assert.deepEqual(idsOf(e), ['discord:m', 'steam:m', 'vrcx:m'], 'all three linked platforms');
  // the primary is the most recently-seen ONLINE identity
  assert.equal(e.status, 'online');
  assert.equal(e.place, 'The Velvet Moth');
  assert.equal(e.ts, 900);
  // each identity carries its OWN state, so the card can badge them apart
  const byId = new Map(e.identities.map((i) => [i.id, i]));
  assert.equal(byId.get('vrcx:m').online, true);
  assert.equal(byId.get('steam:m').online, false);
  assert.equal(byId.get('discord:m').online, false);
  // the primary id is a real member id and is stable (lexicographically first)
  assert.equal(e.id, 'discord:m');
  assert.ok(db.getPerson(e.id), 'the primary id opens the person sheet');
});

test('whoIsOnNow: two identities online at once keep BOTH places on the entry', () => {
  seedOn('steam', 'm');
  seedOn('vrcx', 'm');
  db.linkPersons('steam:m', 'vrcx:m');
  presenceOn('steam', 'm', 'online', 800, 'Voidbreakers');
  presenceOn('vrcx', 'm', 'joinme', 900, 'The Velvet Moth');

  const e = digest.whoIsOnNow().people[0];
  const places = e.identities.filter((i) => i.online).map((i) => i.place).sort();
  assert.deepEqual(places, ['The Velvet Moth', 'Voidbreakers'], 'neither place is dropped');
  assert.equal(e.place, 'The Velvet Moth', 'the primary is the most recent online one');
  assert.equal(e.status, 'joinme');
});

test('whoIsOnNow: count counts HUMANS — linking two online identities drops it by one', () => {
  seedOn('steam', 'a');
  seedOn('discord', 'b');
  presenceOn('steam', 'a', 'online', 900);
  presenceOn('discord', 'b', 'online', 900);

  assert.equal(digest.whoIsOnNow().count, 2, 'two unlinked identities = two people');
  db.linkPersons('steam:a', 'discord:b');
  const after = digest.whoIsOnNow();
  assert.equal(after.count, 1, 'the same two, asserted as one human, are one');
  assert.equal(after.people.length, 1);
  assert.equal(after.people[0].identities.length, 2);
});

test('whoIsOnNow: unlinked people are untouched single-identity entries', () => {
  seedOn('vrcx', 'solo', { handle: 'solo', displayName: 'Solo' });
  presenceOn('vrcx', 'solo', 'online', 900, 'Quiet Library');

  const e = digest.whoIsOnNow().people[0];
  assert.equal(e.identities.length, 1);
  assert.equal(e.id, 'vrcx:solo');
  assert.equal(e.displayName, 'Solo');
  assert.equal(e.place, 'Quiet Library');
  assert.equal(e.online, true);
  assert.equal(e.identities[0].online, true);
});

test('whoIsOnNow: a cluster whose every identity is offline is excluded', () => {
  seedOn('steam', 'z');
  seedOn('discord', 'z');
  db.linkPersons('steam:z', 'discord:z');
  presenceOn('steam', 'z', 'online', 100);
  presenceOn('steam', 'z', 'offline', 200);
  presenceOn('discord', 'z', 'offline', 300);

  assert.deepEqual(digest.whoIsOnNow(), { count: 0, people: [] });
});

test('whoIsOnNow: the reserved self person never appears, in any identity list', () => {
  seedOn('vrcx', 'a');
  presenceOn('vrcx', 'a', 'online', 900);
  selfPresence(1000); // the operator is online too

  const r = digest.whoIsOnNow();
  assert.equal(r.count, 1);
  assert.ok(!r.people.some((p) => p.source === 'self'));
  assert.ok(!r.people.some((p) => p.identities.some((i) => i.source === 'self')));
  // and it is unlinkable, so it can never be dragged into a cluster
  assert.throws(() => db.linkPersons('vrcx:a', 'self:me'), /self person cannot be linked/);
});

test('whoIsOnNow: display fields prefer the most recently active identity that HAS one', () => {
  // vrcx is the only ONLINE identity → it ranks first and names the human.
  seedOn('vrcx', 'b', { handle: 'badgerVR', displayName: 'Badger VR' }, 500);
  // contacts is the freshest OFFLINE identity → it supplies what vrcx lacks.
  seedOn('contacts', 'b', { handle: 'badger', displayName: 'Badger', birthday: '03-04', pronouns: 'they/them', note: 'met at the meetup' }, 2000);
  // steam is older still, but it is the only identity with an avatar.
  seedOn('steam', 'b', { handle: 'badgr', displayName: 'badgr', avatarUrl: 'https://cdn.example/av.png' }, 1000);
  db.linkPersons('vrcx:b', 'contacts:b');
  db.linkPersons('contacts:b', 'steam:b');
  presenceOn('vrcx', 'b', 'online', 5000);

  const e = digest.whoIsOnNow().people[0];
  assert.equal(e.displayName, 'Badger VR', 'the identity you most recently saw them on');
  assert.equal(e.handle, 'badgerVR');
  assert.equal(e.avatarUrl, 'https://cdn.example/av.png', 'kept from the only identity that has one');
  assert.equal(e.birthday, '03-04', 'kept from the only identity that has one');
  assert.equal(e.pronouns, 'they/them');
  assert.equal(e.note, 'met at the meetup');
  // Every value is ONE identity's, verbatim — nothing is merged or invented.
  assert.ok(!/Badger VR.*badgr/.test(String(e.displayName)));
});

test('statusBoard: a linked human is listed once, with their newest status text', () => {
  seedOn('vrcx', 's');
  seedOn('discord', 's');
  db.linkPersons('vrcx:s', 'discord:s');
  db.insertObservation({ source: 'discord', sourceId: 's', kind: 'status', text: 'older, on discord', ts: 100 });
  db.insertObservation({ source: 'vrcx', sourceId: 's', kind: 'status', text: '🏖 away till the 20th', ts: 200 });

  const board = digest.statusBoard();
  assert.equal(board.length, 1, 'one human, not one row per platform');
  assert.equal(board[0].text, '🏖 away till the 20th');
  assert.equal(board[0].ts, 200);
  assert.equal(board[0].source, 'vrcx', 'which identity said it');
  assert.equal(board[0].person.identities.length, 2);
});

test('listPeople: the roster collapses to humans; people.list still lists identities', () => {
  seedOn('steam', 'm', { displayName: 'Marlow' });
  seedOn('vrcx', 'm', { displayName: 'Marlow VR' });
  seedOn('discord', 'm', { displayName: 'marlow' });
  seedOn('vrcx', 'solo', { displayName: 'Solo' });
  db.linkPersons('steam:m', 'vrcx:m');
  db.linkPersons('vrcx:m', 'discord:m');

  assert.equal(db.listPersons({}).length, 4, 'people.list is unchanged — the link picker needs identities');
  const humans = digest.listPeople({});
  assert.equal(humans.length, 2, 'three linked identities + one unlinked = two humans');
  const merged = humans.find((h) => h.identities.length === 3);
  assert.ok(merged, 'the linked human carries all three platforms');
  assert.deepEqual(idsOf(merged), ['discord:m', 'steam:m', 'vrcx:m']);
  assert.ok(humans.some((h) => h.id === 'vrcx:solo' && h.identities.length === 1));
});

test('listPeople: a human matches if ANY identity does, and keeps the whole cluster', () => {
  seedOn('steam', 'm', { displayName: 'Marlow', handle: 'marlowgears' });
  seedOn('discord', 'm', { displayName: 'zzz-other-name', handle: 'zzz' });
  db.linkPersons('steam:m', 'discord:m');

  const hits = digest.listPeople({ q: 'marlow' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].identities.length, 2, 'the Discord half comes along, though it did not match');
});

test('listPeople: never returns the reserved self person', () => {
  seedOn('vrcx', 'a');
  assert.ok(!digest.listPeople({}).some((h) => h.source === 'self'));
  assert.ok(!digest.listPeople({}).some((h) => h.identities.some((i) => i.source === 'self')));
});

test('cluster entries carry displayId — the identity the card is NAMED after', () => {
  seedOn('discord', 'm', { displayName: 'marlow', handle: 'marlow' }, 1000);
  seedOn('vrcx', 'm', { displayName: 'Marlow VR', handle: 'marlowVR' }, 500);
  db.linkPersons('discord:m', 'vrcx:m');
  presenceOn('vrcx', 'm', 'online', 9000);

  const e = digest.whoIsOnNow().people[0];
  assert.equal(e.id, 'discord:m', 'the stable key is the smallest member id');
  assert.equal(e.displayName, 'Marlow VR');
  assert.equal(e.displayId, 'vrcx:m', 'opening the card lands on the identity it shows');
  // Both are real member ids — people.get accepts either and returns the cluster.
  assert.ok(db.getPerson(e.displayId));
  assert.deepEqual(db.cluster(e.displayId).sort(), db.cluster(e.id).sort());
});
