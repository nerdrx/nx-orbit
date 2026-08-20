// Ingest validation + write behaviour (SPEC §3, §0 machine-checkable rules).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/main/db.js';
import * as ingest from '../src/main/ingest.js';
import { freshDb, person, obs } from './helpers.js';

let ctx;
beforeEach(() => {
  ctx = freshDb();
});
afterEach(() => ctx.cleanup());

function batch(over = {}) {
  return {
    plugin: 'vrcx',
    version: '1.0.0',
    emittedAt: Date.now(),
    persons: [],
    observations: [],
    ...over,
  };
}

function obsCount() {
  return db.getDb().prepare('SELECT COUNT(*) c FROM observation').get().c;
}

test('accepts a valid batch and writes persons + observations', () => {
  const p = person({ sourceId: 'usr_a' });
  const res = ingest.submit(
    batch({ persons: [p], observations: [obs({ sourceId: 'usr_a' })] })
  );
  assert.equal(res.ok, true);
  assert.equal(res.accepted.persons, 1);
  assert.equal(res.accepted.observations, 1);
  assert.equal(obsCount(), 1);
  assert.ok(db.getPerson('vrcx:usr_a'));
});

test('rejects a kind outside the enum, writes nothing', () => {
  const p = person({ sourceId: 'usr_a' });
  const res = ingest.submit(
    batch({ persons: [p], observations: [obs({ sourceId: 'usr_a', kind: 'message' })] })
  );
  assert.equal(res.ok, false);
  assert.ok(res.rejected.some((r) => r.field === 'kind'));
  assert.equal(obsCount(), 0);
  assert.equal(db.getPerson('vrcx:usr_a'), null); // whole batch refused
});

test('whole-batch atomicity: one bad record refuses the entire batch', () => {
  const p = person({ sourceId: 'usr_a' });
  const good = obs({ sourceId: 'usr_a', ts: 1000 });
  const bad = obs({ sourceId: 'usr_a', ts: 2000, kind: 'nope' });
  const res = ingest.submit(batch({ persons: [p], observations: [good, bad] }));
  assert.equal(res.ok, false);
  assert.equal(obsCount(), 0); // the good one must NOT have been written
});

test('dedup idempotency: re-submitting the same batch stores no new rows', () => {
  const p = person({ sourceId: 'usr_a' });
  const o = obs({ sourceId: 'usr_a', ts: 12345 });
  const first = ingest.submit(batch({ persons: [p], observations: [o] }));
  assert.equal(first.accepted.observations, 1);
  const second = ingest.submit(batch({ persons: [p], observations: [o] }));
  assert.equal(second.ok, true);
  assert.equal(second.accepted.observations, 0);
  assert.equal(obsCount(), 1);
});

test('rejects unknown/smuggled fields on a person', () => {
  const p = person({ sourceId: 'usr_a', trustLevel: 'trusted' });
  const res = ingest.submit(batch({ persons: [p] }));
  assert.equal(res.ok, false);
  assert.ok(res.rejected.some((r) => r.field === 'trustLevel'));
});

test('rejects unknown/smuggled fields on an observation', () => {
  const p = person({ sourceId: 'usr_a' });
  const res = ingest.submit(
    batch({ persons: [p], observations: [obs({ sourceId: 'usr_a', score: 0.9 })] })
  );
  assert.equal(res.ok, false);
  assert.ok(res.rejected.some((r) => r.field === 'score'));
});

test("rejects a person whose source isn't declared by the plugin", () => {
  const res = ingest.submit(
    batch({ plugin: 'manual', persons: [{ source: 'discord', sourceId: '123', displayName: 'X' }] })
  );
  assert.equal(res.ok, false);
  assert.ok(res.rejected.some((r) => r.field === 'source'));
});

test('rejects an observation about a person not in DB and not in the batch', () => {
  const res = ingest.submit(batch({ observations: [obs({ sourceId: 'ghost' })] }));
  assert.equal(res.ok, false);
  assert.ok(res.rejected.some((r) => r.reason.includes('unknown person')));
});

test('rejects an unknown plugin', () => {
  const res = ingest.submit(batch({ plugin: 'evilcorp' }));
  assert.equal(res.ok, false);
  assert.ok(res.rejected.some((r) => r.field === 'plugin'));
});

test('accepts source:"self" from any plugin but requires sourceId "me"', () => {
  // valid: (self, me) from vrcx
  const ok = ingest.submit(
    batch({
      persons: [{ source: 'self', sourceId: 'me', displayName: '(you)' }],
      observations: [{ source: 'self', sourceId: 'me', kind: 'presence', status: 'online', ts: 1 }],
    })
  );
  assert.equal(ok.ok, true);
  // invalid: a self person that isn't the operator (§0.6)
  const bad = ingest.submit(
    batch({ persons: [{ source: 'self', sourceId: 'someone-else', displayName: 'nope' }] })
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.rejected.some((r) => r.field === 'sourceId'));
});

test('appends an ingest_log row on success only', () => {
  const before = db.getDb().prepare('SELECT COUNT(*) c FROM ingest_log').get().c;
  ingest.submit(batch({ persons: [person({ sourceId: 'usr_a' })] }));
  ingest.submit(batch({ observations: [obs({ sourceId: 'ghost' })] })); // fails
  const after = db.getDb().prepare('SELECT COUNT(*) c FROM ingest_log').get().c;
  assert.equal(after - before, 1);
});
