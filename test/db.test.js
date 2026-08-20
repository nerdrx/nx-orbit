// Storage layer: schema, cascade delete, prune, links, settings (SPEC §4/§0.5).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/main/db.js';
import { freshDb } from './helpers.js';

let ctx;
beforeEach(() => {
  ctx = freshDb();
});
afterEach(() => ctx.cleanup());

function obsCount() {
  return db.getDb().prepare('SELECT COUNT(*) c FROM observation').get().c;
}

test('open() seeds schema_version and the reserved self person', () => {
  assert.equal(db.getMeta('schema_version'), String(db.SCHEMA_VERSION));
  assert.ok(db.getPerson('self:me'));
});

test('upsertPerson preserves first_seen and never clobbers note with null', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A', note: 'my note' }, 1000);
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A2' }, 2000); // no note field
  const p = db.getPerson('vrcx:a');
  assert.equal(p.displayName, 'A2');
  assert.equal(p.note, 'my note'); // preserved
  assert.equal(p.firstSeen, 1000);
  assert.equal(p.lastSeen, 2000);
});

test('forgetPerson cascades observations and clears links (§0.5)', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'B' });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'presence', status: 'online', ts: 1 });
  db.linkPersons('vrcx:a', 'discord:b');
  assert.equal(obsCount(), 1);

  db.forgetPerson('vrcx:a');
  assert.equal(db.getPerson('vrcx:a'), null);
  assert.equal(obsCount(), 0); // cascaded
  assert.equal(db.getLinks('discord:b').length, 0); // link cleared
});

test('pruneOlderThan deletes only observations before the cutoff', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A' });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'presence', status: 'online', ts: 100 });
  db.insertObservation({ source: 'vrcx', sourceId: 'a', kind: 'presence', status: 'offline', ts: 5000 });
  const removed = db.pruneOlderThan(1000);
  assert.equal(removed, 1);
  assert.equal(obsCount(), 1);
});

test('listPersons excludes self and filters by source/query', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'Alice' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'Bob' });
  assert.equal(db.listPersons().length, 2); // self excluded by default
  assert.equal(db.listPersons({ source: 'vrcx' }).length, 1);
  assert.equal(db.listPersons({ q: 'ali' })[0].displayName, 'Alice');
  assert.equal(db.listPersons({ includeSelf: true }).length, 3);
});

test('settings round-trip with defaults', () => {
  const s = db.getSettings();
  assert.equal(s.retentionDays, 365);
  assert.equal(s.ingestPort, 8477);
  db.setSettings({ retentionDays: 90, ingestPort: 9000, sources: { vrcx: { enabled: true } } });
  const s2 = db.getSettings();
  assert.equal(s2.retentionDays, 90);
  assert.equal(s2.ingestPort, 9000);
  assert.deepEqual(s2.sources, { vrcx: { enabled: true } });
});

test('setNote updates the CRM note', () => {
  db.upsertPerson({ source: 'vrcx', sourceId: 'a', displayName: 'A' });
  db.setNote('vrcx:a', 'met at Framework world, likes DnB');
  assert.equal(db.getPerson('vrcx:a').note, 'met at Framework world, likes DnB');
});

// --- identity clusters (SPEC §2.1) -----------------------------------------
function seedTrio() {
  db.upsertPerson({ source: 'steam', sourceId: 'a', displayName: 'A' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'B' });
  db.upsertPerson({ source: 'vrcx', sourceId: 'c', displayName: 'C' });
}

test('cluster: a chain A-B-C returns all three from ANY member', () => {
  seedTrio();
  db.linkPersons('steam:a', 'discord:b');
  db.linkPersons('discord:b', 'vrcx:c'); // A-B-C, not directly A-C
  const want = ['steam:a', 'discord:b', 'vrcx:c'].sort();
  for (const start of want) {
    assert.deepEqual(db.cluster(start).sort(), want, `from ${start}`);
  }
});

test('cluster: includes the id itself even with no links', () => {
  seedTrio();
  assert.deepEqual(db.cluster('steam:a'), ['steam:a']);
});

test('cluster: an unrelated person is excluded', () => {
  seedTrio();
  db.upsertPerson({ source: 'vrcx', sourceId: 'z', displayName: 'Z' });
  db.linkPersons('steam:a', 'discord:b');
  assert.ok(!db.cluster('steam:a').includes('vrcx:z'));
});

test('cluster: a cycle terminates (does not spin)', () => {
  seedTrio();
  db.linkPersons('steam:a', 'discord:b');
  db.linkPersons('discord:b', 'vrcx:c');
  db.linkPersons('vrcx:c', 'steam:a'); // closes the loop A-B-C-A
  assert.deepEqual(db.cluster('steam:a').sort(), ['discord:b', 'steam:a', 'vrcx:c']);
});

test('unlink: removes only the one edge; the rest of the cluster survives', () => {
  seedTrio();
  db.linkPersons('steam:a', 'discord:b');
  db.linkPersons('discord:b', 'vrcx:c'); // chain A-B-C
  db.unlinkPersons('discord:b', 'vrcx:c'); // cut the tail
  // A-B still one cluster; C now alone.
  assert.deepEqual(db.cluster('steam:a').sort(), ['discord:b', 'steam:a']);
  assert.deepEqual(db.cluster('vrcx:c'), ['vrcx:c']);
});

test('unlink: works in either stored orientation', () => {
  seedTrio();
  db.linkPersons('steam:a', 'discord:b'); // stored (a, b)
  db.unlinkPersons('discord:b', 'steam:a'); // asked (b, a)
  assert.deepEqual(db.cluster('steam:a'), ['steam:a']);
});

test('link: rejects a self-link (id === id)', () => {
  seedTrio();
  assert.throws(() => db.linkPersons('steam:a', 'steam:a'), /themselves/);
});

test('link: rejects linking the reserved self person', () => {
  seedTrio();
  assert.throws(() => db.linkPersons('self:me', 'steam:a'), /self person/);
  assert.throws(() => db.linkPersons('steam:a', 'self:me'), /self person/);
});

test('link: same-cluster re-link is a harmless no-op', () => {
  seedTrio();
  db.linkPersons('steam:a', 'discord:b');
  db.linkPersons('steam:a', 'discord:b'); // duplicate — must not throw or fork
  assert.deepEqual(db.cluster('steam:a').sort(), ['discord:b', 'steam:a']);
});

test('forgetPerson clears link rows in BOTH orientations', () => {
  seedTrio();
  db.linkPersons('steam:a', 'discord:b'); // a is the a-side here
  db.linkPersons('vrcx:c', 'steam:a'); // a is the b-side here
  db.forgetPerson('steam:a');
  assert.equal(db.getLinks('discord:b').length, 0);
  assert.equal(db.getLinks('vrcx:c').length, 0);
  assert.deepEqual(db.cluster('discord:b'), ['discord:b']);
});
