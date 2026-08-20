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
