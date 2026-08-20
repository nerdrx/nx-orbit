// Removal at PLATFORM granularity (SPEC §0.5): countBySource / forgetSource.
//
// The incident: a dev build wrote a plugin's test fixtures — invented Steam and
// Discord accounts — into a real friend roster, and the only way to get them out
// was deleting people one by one. The regression that matters most here is the
// blast radius: removing one source must leave every other source's people,
// observations and audit rows exactly as they were.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/main/db.js';
import { freshDb } from './helpers.js';

let ctx;
beforeEach(() => {
  ctx = freshDb();
});
afterEach(() => ctx.cleanup());

const obsCount = () => db.getDb().prepare('SELECT COUNT(*) c FROM observation').get().c;
const logCount = (plugin) =>
  db.getDb().prepare('SELECT COUNT(*) c FROM ingest_log WHERE plugin = ?').get(plugin).c;

// Two platforms with different, deliberately unequal populations, plus audit
// rows for each — so "left the other one untouched" is a real assertion.
function seed() {
  for (let i = 0; i < 3; i++) {
    db.upsertPerson({ source: 'steam', sourceId: `s${i}`, displayName: `Steam ${i}` });
    for (let k = 0; k < 4; k++) {
      db.insertObservation({ source: 'steam', sourceId: `s${i}`, kind: 'presence', status: 'online', ts: 1000 + i * 10 + k });
    }
  }
  for (let i = 0; i < 2; i++) {
    db.upsertPerson({ source: 'discord', sourceId: `d${i}`, displayName: `Discord ${i}` });
    db.insertObservation({ source: 'discord', sourceId: `d${i}`, kind: 'presence', status: 'online', ts: 2000 + i });
  }
  db.logIngest({ plugin: 'steam-orbit', version: '1.0.0', receivedAt: 10, nPersons: 3, nObs: 12 });
  db.logIngest({ plugin: 'steam-orbit', version: '1.0.0', receivedAt: 20, nPersons: 3, nObs: 0 });
  db.logIngest({ plugin: 'vencord-orbit-bridge', version: '1.0.0', receivedAt: 30, nPersons: 2, nObs: 2 });
}

test('countBySource reports exactly one platform’s people and observations', () => {
  seed();
  assert.deepEqual(db.countBySource('steam'), { persons: 3, observations: 12 });
  assert.deepEqual(db.countBySource('discord'), { persons: 2, observations: 2 });
  assert.deepEqual(db.countBySource('lastfm'), { persons: 0, observations: 0 });
});

test('counting has no side effects — the numbers a confirm shows cost nothing', () => {
  seed();
  const before = db.countBySource('steam');
  db.countBySource('steam');
  db.countBySource('discord');
  db.countBySource('steam');
  assert.deepEqual(db.countBySource('steam'), before);
  assert.deepEqual(db.countBySource('discord'), { persons: 2, observations: 2 });
  assert.equal(db.listPersons().length, 5);
  assert.equal(obsCount(), 14);
});

test('forgetSource deletes that source’s people, observations and audit rows', () => {
  seed();
  const removed = db.forgetSource('steam', { plugins: ['steam-orbit'] });

  assert.equal(removed.persons, 3);
  assert.equal(removed.observations, 12);
  assert.equal(removed.ingestLogRows, 2);

  assert.equal(db.listPersons({ source: 'steam' }).length, 0);
  assert.deepEqual(db.countBySource('steam'), { persons: 0, observations: 0 });
  assert.equal(logCount('steam-orbit'), 0);
});

test('forgetSource leaves every OTHER source untouched (the regression)', () => {
  seed();
  const otherBefore = db.countBySource('discord');
  db.forgetSource('steam', { plugins: ['steam-orbit'] });

  assert.deepEqual(db.countBySource('discord'), otherBefore);
  assert.deepEqual(db.countBySource('discord'), { persons: 2, observations: 2 });
  assert.equal(db.listPersons({ source: 'discord' }).length, 2);
  assert.equal(logCount('vencord-orbit-bridge'), 1);
  assert.equal(obsCount(), 2); // only discord's survive
});

test('the reserved self person is refused — it is the heatmap’s "me" axis', () => {
  seed();
  db.insertObservation({ source: 'self', sourceId: 'me', kind: 'presence', status: 'online', ts: 500 });
  assert.throws(() => db.forgetSource('self'), /self/i);
  // Nothing partial: self is still there, with its presence history.
  assert.ok(db.getPerson('self:me'));
  assert.deepEqual(db.countBySource('self'), { persons: 1, observations: 1 });
});

test('an empty or missing source name is refused rather than deleting nothing quietly', () => {
  seed();
  assert.throws(() => db.forgetSource(''), /source name/);
  assert.throws(() => db.forgetSource(undefined), /source name/);
  assert.equal(db.listPersons().length, 5);
});

test('link edges to removed people are cleaned in BOTH stored orientations', () => {
  seed();
  db.upsertPerson({ source: 'vrcx', sourceId: 'v0', displayName: 'V' });
  // One edge stored steam→discord, one stored discord→steam: the delete must
  // match a_source and b_source, or half the edges survive as dangling halves.
  db.linkPersons('steam:s0', 'discord:d0');
  db.linkPersons('discord:d1', 'steam:s1');
  db.linkPersons('vrcx:v0', 'discord:d0'); // unrelated to steam — must survive
  assert.equal(db.getLinks('discord:d0').length, 2);

  db.forgetSource('steam', { plugins: ['steam-orbit'] });

  assert.equal(db.getDb().prepare('SELECT COUNT(*) c FROM person_link').get().c, 1);
  assert.deepEqual(db.cluster('discord:d0').sort(), ['discord:d0', 'vrcx:v0']);
  assert.deepEqual(db.cluster('discord:d1'), ['discord:d1']);
});

test('forgetSource does not stop the source coming back — it only deletes', () => {
  seed();
  db.forgetSource('steam', { plugins: ['steam-orbit'] });
  // Deleting data is not disconnecting: the very next collection re-upserts.
  db.upsertPerson({ source: 'steam', sourceId: 's0', displayName: 'Steam 0' });
  db.insertObservation({ source: 'steam', sourceId: 's0', kind: 'presence', status: 'online', ts: 9999 });
  assert.deepEqual(db.countBySource('steam'), { persons: 1, observations: 1 });
});

test('a source with nothing collected removes nothing and reports zero', () => {
  seed();
  const removed = db.forgetSource('mastodon', { plugins: ['mastodon-orbit'] });
  assert.deepEqual(
    { persons: removed.persons, observations: removed.observations, ingestLogRows: removed.ingestLogRows },
    { persons: 0, observations: 0, ingestLogRows: 0 },
  );
  assert.equal(db.listPersons().length, 5);
});
