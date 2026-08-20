// External-emitter visibility: the ingest_log summary (SPEC §4), the merged
// sources.status() shape (SPEC §6), and the health thresholds the Sources view
// renders. Every clock is INJECTED — nothing here may depend on wall time.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as db from '../src/main/db.js';
import * as ingest from '../src/main/ingest.js';
import { getOrCreateToken } from '../src/main/ingest-server.js';
import {
  mergeSourceStatus,
  healthOf,
  EMITTER_LIVE_MS,
  READER_LIVE_MS,
} from '../src/main/sources-status.js';
import { freshDb } from './helpers.js';

const MIN = 60000;

let ctx;
beforeEach(() => {
  ctx = freshDb();
});
afterEach(() => ctx.cleanup());

// ---------------------------------------------------------------- db summary

test('ingestLogSummary groups by plugin and returns each plugin latest delivery', () => {
  db.logIngest({ plugin: 'vencord-orbit-bridge', version: '0.9.0', receivedAt: 1000, nPersons: 3, nObs: 5, rejected: null });
  db.logIngest({ plugin: 'vencord-orbit-bridge', version: '1.0.0', receivedAt: 3000, nPersons: 4, nObs: 7, rejected: null });
  db.logIngest({ plugin: 'vencord-orbit-bridge', version: '0.9.5', receivedAt: 2000, nPersons: 9, nObs: 9, rejected: null });
  db.logIngest({ plugin: 'lastfm-orbit', version: '1.2.0', receivedAt: 2500, nPersons: 1, nObs: 2, rejected: null });

  const rows = db.ingestLogSummary();
  assert.equal(rows.length, 2); // one row per plugin, not one per batch
  const byPlugin = Object.fromEntries(rows.map((r) => [r.plugin, r]));

  const v = byPlugin['vencord-orbit-bridge'];
  assert.equal(v.lastReceivedAt, 3000);   // latest by received_at, not by insert order
  assert.equal(v.version, '1.0.0');       // version comes from THAT row
  assert.equal(v.nPersons, 4);
  assert.equal(v.nObs, 7);
  assert.equal(v.deliveries, 3);          // lifetime batch count
  assert.equal(v.totalObs, 21);           // lifetime observations (5+7+9)

  assert.equal(byPlugin['lastfm-orbit'].deliveries, 1);
  assert.equal(byPlugin['lastfm-orbit'].totalObs, 2);
});

test('ingestLogSummary breaks a received_at tie on id, and can filter by plugin', () => {
  db.logIngest({ plugin: 'matrix-orbit', version: 'a', receivedAt: 500, nPersons: 1, nObs: 1, rejected: null });
  db.logIngest({ plugin: 'matrix-orbit', version: 'b', receivedAt: 500, nPersons: 1, nObs: 1, rejected: null });
  db.logIngest({ plugin: 'twitter-orbit', version: 'z', receivedAt: 900, nPersons: 1, nObs: 1, rejected: null });

  assert.equal(db.ingestLogSummary()[0].plugin, 'matrix-orbit'); // ordered by plugin
  const only = db.ingestLogSummary({ plugin: 'matrix-orbit' });
  assert.equal(only.length, 1);
  assert.equal(only[0].version, 'b'); // the later row wins the tie
});

test('ingestLogSummary ignores rejected batches — a rejection is not a delivery', () => {
  db.logIngest({ plugin: 'twitter-orbit', version: '1.0.0', receivedAt: 1000, nPersons: 2, nObs: 4, rejected: null });
  db.logIngest({ plugin: 'twitter-orbit', version: '1.0.0', receivedAt: 5000, nPersons: 0, nObs: 0, rejected: [{ reason: 'bad kind' }] });

  const [row] = db.ingestLogSummary();
  assert.equal(row.lastReceivedAt, 1000);
  assert.equal(row.deliveries, 1);
});

test('ingestLogSummary is empty on a fresh database', () => {
  assert.deepEqual(db.ingestLogSummary(), []);
});

test('personCountsBySource counts people per source and excludes the self person', () => {
  db.upsertPerson({ source: 'discord', sourceId: 'a', displayName: 'A' });
  db.upsertPerson({ source: 'discord', sourceId: 'b', displayName: 'B' });
  db.upsertPerson({ source: 'vrcx', sourceId: 'usr_1', displayName: 'C' });

  const counts = db.personCountsBySource();
  assert.equal(counts.discord, 2);
  assert.equal(counts.vrcx, 1);
  assert.equal(counts.self, undefined); // seeded by open(), never a friend (§2.1)
});

// ------------------------------------------------------------------- health

test('healthOf covers every threshold with an injected clock', () => {
  const now = 1_000_000_000;
  // never delivered / never ran
  assert.equal(healthOf({ sourceKind: 'emitter', at: null, now }), 'waiting');
  assert.equal(healthOf({ sourceKind: 'reader', at: null, lastOk: null, now }), 'waiting');
  // a reader whose last run failed is an error regardless of when it ran
  assert.equal(healthOf({ sourceKind: 'reader', at: now - 1000, lastOk: false, now }), 'error');
  assert.equal(healthOf({ sourceKind: 'reader', at: null, lastOk: false, now }), 'error');
  // emitters: inside the window is live, one ms past it is idle
  assert.equal(healthOf({ sourceKind: 'emitter', at: now - EMITTER_LIVE_MS, now }), 'live');
  assert.equal(healthOf({ sourceKind: 'emitter', at: now - EMITTER_LIVE_MS - 1, now }), 'idle');
  // readers get the longer window (the scheduler only fires every 15 min)
  assert.equal(healthOf({ sourceKind: 'reader', at: now - 20 * MIN, lastOk: true, now }), 'live');
  assert.equal(healthOf({ sourceKind: 'reader', at: now - READER_LIVE_MS - 1, lastOk: true, now }), 'idle');
  // an emitter has no "error": a rejected batch never becomes a delivery
  assert.equal(healthOf({ sourceKind: 'emitter', at: now - 5 * MIN, lastOk: false, now }), 'live');
});

// -------------------------------------------------------------------- merge

const PLUGIN_SOURCES = ingest.PLUGIN_SOURCES;
const NOW = 1_700_000_000_000;

function readers() {
  return [
    { plugin: 'vrcx', source: 'vrcx', lastRun: NOW - 5 * MIN, lastOk: true, nPersons: 12, configurable: false, connected: true, account: null },
    { plugin: 'steam', source: 'steam', lastRun: null, lastOk: null, nPersons: 0, configurable: true, connected: false, account: null },
  ];
}

test('status merges in-process readers with emitters known from ingest_log', () => {
  const merged = mergeSourceStatus({
    readers: readers(),
    deliveries: [
      { plugin: 'vencord-orbit-bridge', version: '1.0.0', lastReceivedAt: NOW - 2 * MIN, nPersons: 34, nObs: 17, deliveries: 900, totalObs: 1204 },
    ],
    personCounts: { discord: 34, vrcx: 12 },
    pluginSources: PLUGIN_SOURCES,
    now: NOW,
  });

  // readers first, keeping every field the old shape carried
  const vrcx = merged.find((s) => s.plugin === 'vrcx');
  assert.equal(vrcx.sourceKind, 'reader');
  assert.equal(vrcx.configurable, false);
  assert.equal(vrcx.connected, true);
  assert.equal(vrcx.nPersons, 12);
  assert.equal(vrcx.lastRun, NOW - 5 * MIN);
  assert.equal(vrcx.lastOk, true);
  assert.equal(vrcx.health, 'live');
  assert.equal(merged.indexOf(vrcx), 0);

  const bridge = merged.find((s) => s.plugin === 'vencord-orbit-bridge');
  assert.equal(bridge.sourceKind, 'emitter');
  assert.equal(bridge.health, 'live');
  assert.equal(bridge.lastReceivedAt, NOW - 2 * MIN);
  assert.equal(bridge.ageMs, 2 * MIN);
  assert.equal(bridge.version, '1.0.0');
  assert.equal(bridge.nObs, 17);
  assert.equal(bridge.totalObs, 1204);
  assert.equal(bridge.deliveries, 900);
  assert.equal(bridge.connected, true);
  assert.deepEqual(bridge.sources, ['discord']);
  // the person count comes from the DB, not from the batch (34 Discord people)
  assert.equal(bridge.nPersons, 34);
  // shape-compatible with a reader entry for anything reading the old fields
  assert.equal(bridge.configurable, false);
  assert.equal(bridge.account, null);
  assert.equal(bridge.lastOk, true);
});

test('known emitters that have never delivered are listed as waiting, not omitted', () => {
  const merged = mergeSourceStatus({
    readers: readers(),
    deliveries: [],
    personCounts: {},
    pluginSources: PLUGIN_SOURCES,
    now: NOW,
  });
  const emitters = merged.filter((s) => s.sourceKind === 'emitter');

  // every registry entry except manual and the reader-covered ones
  assert.deepEqual(
    emitters.map((e) => e.plugin).sort(),
    ['contacts-orbit', 'lastfm-orbit', 'mastodon-orbit', 'matrix-orbit', 'twitter-orbit', 'vencord-orbit-bridge']
  );
  for (const e of emitters) {
    assert.equal(e.health, 'waiting');
    assert.equal(e.connected, false);
    assert.equal(e.lastReceivedAt, null);
    assert.equal(e.ageMs, null);
    assert.equal(e.version, null);
    assert.equal(e.lastOk, null); // never "failed" — it was simply never installed
  }
  // manual is the in-app CRM path, never an emitter
  assert.equal(merged.some((s) => s.plugin === 'manual'), false);
  // steam-orbit writes the `steam` source, which the in-process reader covers —
  // it must not nag beside the Steam connect card
  assert.equal(merged.some((s) => s.sourceKind === 'emitter' && s.plugin === 'steam-orbit'), false);
});

test('a reader that covers a registry entry absorbs that entry deliveries', () => {
  const merged = mergeSourceStatus({
    readers: readers(),
    deliveries: [
      { plugin: 'steam-orbit', version: '2.1.0', lastReceivedAt: NOW - MIN, nPersons: 8, nObs: 3, deliveries: 40, totalObs: 500 },
    ],
    personCounts: { steam: 8 },
    pluginSources: PLUGIN_SOURCES,
    now: NOW,
  });
  const steam = merged.find((s) => s.plugin === 'steam');
  assert.equal(steam.sourceKind, 'reader');
  assert.equal(steam.lastReceivedAt, NOW - MIN);
  assert.equal(steam.version, '2.1.0');
  assert.equal(steam.totalObs, 500);
  // ...and no duplicate emitter row for the same thing
  assert.equal(merged.filter((s) => s.plugin === 'steam-orbit').length, 0);
  // the reader's own health still comes from the SCHEDULER, not the log: it has
  // never run in this process, so it is waiting.
  assert.equal(steam.health, 'waiting');
});

test('health across the merged list: live, idle, waiting, error', () => {
  const merged = mergeSourceStatus({
    readers: [
      { plugin: 'vrcx', source: 'vrcx', lastRun: NOW - 3 * 60 * MIN, lastOk: false, nPersons: 12, configurable: false, connected: true, account: null },
    ],
    deliveries: [
      { plugin: 'vencord-orbit-bridge', version: '1.0.0', lastReceivedAt: NOW - 2 * MIN, nPersons: 1, nObs: 1, deliveries: 2, totalObs: 2 },
      { plugin: 'lastfm-orbit', version: '1.0.0', lastReceivedAt: NOW - 3 * 24 * 60 * MIN, nPersons: 1, nObs: 1, deliveries: 9, totalObs: 9 },
    ],
    personCounts: {},
    pluginSources: PLUGIN_SOURCES,
    now: NOW,
  });
  const h = Object.fromEntries(merged.map((s) => [s.plugin, s]));

  assert.equal(h['vrcx'].health, 'error');                      // reader, lastOk === false
  assert.equal(h['vencord-orbit-bridge'].health, 'live');        // 2 min ago
  assert.equal(h['lastfm-orbit'].health, 'idle');                // 3 days ago
  assert.equal(h['lastfm-orbit'].ageMs, 3 * 24 * 60 * MIN);      // the UI says "no delivery in 3 days"
  assert.equal(h['twitter-orbit'].health, 'waiting');            // never delivered

  // emitters: delivering ones first (newest first), never-seen ones last
  const emitters = merged.filter((s) => s.sourceKind === 'emitter');
  assert.equal(emitters[0].plugin, 'vencord-orbit-bridge');
  assert.equal(emitters[1].plugin, 'lastfm-orbit');
  assert.equal(emitters.at(-1).lastReceivedAt, null);
});

test('merge tolerates an empty world and an unknown plugin in the log', () => {
  assert.deepEqual(mergeSourceStatus(), []);
  const merged = mergeSourceStatus({
    readers: [],
    deliveries: [{ plugin: 'some-third-party-source', version: '0.1.0', lastReceivedAt: NOW, nPersons: 1, nObs: 1, deliveries: 1, totalObs: 1 }],
    pluginSources: PLUGIN_SOURCES,
    now: NOW,
  });
  const third = merged.find((s) => s.plugin === 'some-third-party-source');
  assert.equal(third.sourceKind, 'emitter');
  assert.equal(third.health, 'live');
  assert.deepEqual(third.sources, []);
  assert.equal(third.nPersons, 0);
});

test('end to end: a batch through ingest.submit becomes a live emitter row', () => {
  const ts = Date.now();
  const res = ingest.submit({
    plugin: 'vencord-orbit-bridge',
    version: '1.0.0',
    emittedAt: ts,
    persons: [
      { source: 'discord', sourceId: '1', displayName: 'One' },
      { source: 'discord', sourceId: '2', displayName: 'Two' },
    ],
    observations: [{ source: 'discord', sourceId: '1', kind: 'presence', status: 'online', ts }],
  });
  assert.equal(res.ok, true);

  const deliveries = db.ingestLogSummary();
  const merged = mergeSourceStatus({
    readers: readers(),
    deliveries,
    personCounts: db.personCountsBySource(),
    pluginSources: PLUGIN_SOURCES,
    now: deliveries[0].lastReceivedAt, // the delivery instant, no wall-clock drift
  });
  const bridge = merged.find((s) => s.plugin === 'vencord-orbit-bridge');
  assert.equal(bridge.health, 'live');
  assert.equal(bridge.nPersons, 2);   // "2 Discord people"
  assert.equal(bridge.nObs, 1);
  assert.equal(bridge.version, '1.0.0');
});

// ------------------------------------------------------------- token surface

test('the ingest token is stable, 0600, and is what sources.token() returns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-token-'));
  const path = join(dir, 'ingest.token');
  try {
    const first = getOrCreateToken(path);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(getOrCreateToken(path), first); // idempotent: never rotates itself
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }

    // index.js's sources.token() is exactly this behind an IPC hop.
    const api = { token: async () => ({ token: getOrCreateToken(path) }) };
    return api.token().then((r) => assert.deepEqual(r, { token: first }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sources.token is whitelisted end to end (ipc channel, handler, preload)', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const ipc = read('../src/main/ipc.js');
  // A channel that is in CHANNELS but has no handler (or vice versa) is the
  // exact failure that makes a renderer button do nothing.
  assert.match(ipc, /'sources\.token',/);
  assert.match(ipc, /handle\('sources\.token'/);
  // The preload is the only whitelist that matters at runtime.
  assert.match(read('../src/main/preload.cjs'), /token: \(\) => call\('sources\.token'\)/);
  // ...and the main process must actually implement it.
  assert.match(read('../src/main/index.js'), /token: async \(\)/);
});
