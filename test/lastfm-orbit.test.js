// test/lastfm-orbit.test.js — the lastfm-orbit external emitter.
// Runs the CLI offline (--dry-run --from-fixture) and pushes the emitted batch
// through the REAL core validator. The load-bearing assertion in this file is
// the negative one: a scrobble must NEVER become a presence observation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ingest from '../src/main/ingest.js';
import { freshDb } from './helpers.js';
import { asArray, largestImage, toPerson, toStatusObservation, buildBatch } from '../plugins/lastfm-orbit/index.js';

const CLI = fileURLToPath(new URL('../plugins/lastfm-orbit/index.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../plugins/lastfm-orbit/fixture.sample.json', import.meta.url));
const SNAPSHOT_NAME = 'lastfm-orbit.snapshot.fixture.json';

function runCli(args, { snapshot } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orbit-lastfm-home-'));
  try {
    if (snapshot) {
      mkdirSync(join(home, '.config', 'nx-orbit'), { recursive: true });
      writeFileSync(join(home, '.config', 'nx-orbit', SNAPSHOT_NAME), JSON.stringify(snapshot));
    }
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, NX_ORBIT_TOKEN: '' },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const dryRun = (opts, extra = []) => runCli(['--from-fixture', FIXTURE, '--dry-run', ...extra], opts);

// ---------------------------------------------------------------- CLI

test('lastfm-orbit --dry-run --from-fixture emits a batch the core accepts', () => {
  const batch = dryRun();
  const t = freshDb();
  try {
    const res = ingest.submit(batch);
    assert.equal(res.ok, true, 'core rejected: ' + JSON.stringify(res.rejected));
  } finally {
    t.cleanup();
  }
});

test('batch envelope matches SPEC §3 and the plugin registry', () => {
  const batch = dryRun();
  assert.equal(batch.plugin, 'lastfm-orbit');
  assert.deepEqual(ingest.PLUGIN_SOURCES['lastfm-orbit'], ['lastfm']);
  assert.equal(typeof batch.version, 'string');
  assert.ok(batch.emittedAt > 1_600_000_000_000);
});

test('every person is lastfm-sourced, or the reserved (self, me)', () => {
  const batch = dryRun();
  const selves = batch.persons.filter(p => p.source === 'self');
  assert.equal(selves.length, 1);
  assert.equal(selves[0].sourceId, 'me');
  assert.equal(selves[0].handle, 'nerdrx');
  for (const p of batch.persons) assert.ok(p.source === 'lastfm' || p.source === 'self', p.source);
});

test('SCROBBLES ARE NOT PRESENCE — zero presence observations, ever', () => {
  const batch = dryRun();
  assert.equal(batch.observations.filter(o => o.kind === 'presence').length, 0);
  // and no status VALUE at all: Last.fm publishes no presence ring to map onto
  for (const o of batch.observations) assert.equal(o.status, undefined);
});

test('observation kinds and timestamps are in-spec, no VRChat rings', () => {
  const batch = dryRun();
  for (const o of batch.observations) {
    assert.ok(ingest.OBS_KINDS.has(o.kind), `kind ${o.kind}`);
    assert.notEqual(o.status, 'joinme');
    assert.notEqual(o.status, 'askme');
    assert.equal(typeof o.ts, 'number');
    assert.ok(o.ts > 1_600_000_000_000 && o.ts < 4_000_000_000_000, 'ts is epoch ms');
  }
});

test('every observation subject is present in persons', () => {
  const batch = dryRun();
  const keys = new Set(batch.persons.map(p => p.source + ' ' + p.sourceId));
  for (const o of batch.observations) assert.ok(keys.has(o.source + ' ' + o.sourceId));
});

test('a now-playing friend becomes a verbatim status at now; a scrobble at its own ts', () => {
  const before = Date.now();
  const batch = dryRun();
  const after = Date.now();
  const obs = id => batch.observations.find(o => o.sourceId === id && o.kind === 'status');

  const aria = obs('ariaplays'); // "@attr": { nowplaying: "true" }
  assert.equal(aria.text, '♪ Alix Perez — Forsaken');
  assert.ok(aria.ts >= before && aria.ts <= after, 'now-playing is timestamped now');

  const kaz = obs('kazmusic'); // finished scrobble with date.uts 1755630000
  assert.equal(kaz.text, '♪ Fishmans — Long Season');
  assert.equal(kaz.ts, 1755630000 * 1000, 'a past scrobble keeps its published time');

  // the operator can be listening too — but still no presence for them either
  const me = batch.observations.find(o => o.source === 'self');
  assert.equal(me.kind, 'status');
  assert.equal(me.text, '♪ Boards of Canada — Roygbiv');
});

test('friends with nothing to report get a person row and no status', () => {
  const batch = dryRun();
  // quietlistener: empty track array. privatepete: recent-tracks unavailable (null).
  for (const id of ['quietlistener', 'privatepete']) {
    assert.ok(batch.persons.some(p => p.sourceId === id), `${id} still has a person row`);
    assert.equal(batch.observations.some(o => o.sourceId === id), false, `${id} has no observation`);
  }
});

test('persons carry allow-listed fields only, with sensible display-name fallback', () => {
  const batch = dryRun();
  const by = id => batch.persons.find(p => p.sourceId === id);
  assert.equal(by('ariaplays').displayName, 'Aria'); // realname
  assert.equal(by('kazmusic').displayName, 'kazmusic'); // empty realname → the name
  assert.equal(by('quietlistener').avatarUrl, undefined); // empty image → omitted, not ''
  assert.equal(by('ariaplays').avatarUrl, 'https://lastfm.freetls.fastly.net/i/u/300x300/aria.png');
});

test('--max-friends caps the roster', () => {
  const batch = dryRun(undefined, ['--max-friends', '2']);
  assert.equal(batch.persons.filter(p => p.source === 'lastfm').length, 2);
});

// ---------------------------------------------------- snapshot diffing

test('re-running with the same track emits no duplicate status (idempotent)', () => {
  const first = dryRun();
  const friends = {};
  for (const p of first.persons.filter(p => p.source === 'lastfm')) {
    const o = first.observations.find(x => x.sourceId === p.sourceId && x.kind === 'status');
    friends[p.sourceId] = {
      displayName: p.displayName,
      avatarUrl: p.avatarUrl ?? '',
      handle: p.handle,
      track: o ? (o.ts > 1_780_000_000_000 ? 'np:' + o.text : `sc:${o.ts}:${o.text}`) : undefined,
    };
  }
  const selfObs = first.observations.find(o => o.source === 'self');
  const again = dryRun({ snapshot: { version: 1, friends, selfTrack: 'np:' + selfObs.text } });
  assert.equal(again.observations.length, 0, JSON.stringify(again.observations));
  assert.ok(again.persons.length > 0, 'persons are still re-upserted');
});

test('a changed realname or avatar becomes nick / avatar; a lost friend becomes friend', () => {
  const snapshot = {
    version: 1,
    friends: {
      ariaplays: {
        displayName: 'aria',
        avatarUrl: 'https://lastfm.freetls.fastly.net/i/u/300x300/aria-old.png',
        handle: 'ariaplays',
        track: 'np:♪ Alix Perez — Forsaken',
      },
      goneuser: { displayName: 'Gone', avatarUrl: '', handle: 'goneuser' },
    },
  };
  const batch = dryRun({ snapshot });
  const of = (id, kind) => batch.observations.filter(o => o.sourceId === id && o.kind === kind);

  assert.equal(of('ariaplays', 'nick')[0].text, 'Aria');
  assert.equal(of('ariaplays', 'nick')[0].meta.previous, 'aria');
  assert.equal(of('ariaplays', 'avatar').length, 1);
  assert.equal(of('ariaplays', 'status').length, 0, 'same track as the snapshot → no repeat');
  assert.equal(of('goneuser', 'friend')[0].meta.state, 'unfriended');
  assert.ok(batch.persons.some(p => p.sourceId === 'goneuser'), 'unfriended person is in-batch');
  assert.equal(of('kazmusic', 'friend')[0].meta.state, 'friended'); // new on a non-first run

  const t = freshDb();
  try {
    assert.equal(ingest.submit(batch).ok, true);
  } finally {
    t.cleanup();
  }
});

test('first run invents no friending timestamps', () => {
  const batch = dryRun({ snapshot: null });
  assert.equal(batch.observations.filter(o => o.kind === 'friend').length, 0);
});

test('buildBatch never emits presence, whatever the inputs', () => {
  const entries = [
    {
      person: { source: 'lastfm', sourceId: 'a', handle: 'a', displayName: 'A' },
      statusObs: { source: 'lastfm', sourceId: 'a', kind: 'status', text: '♪ X — Y', ts: 1, _key: 'np:x' },
    },
  ];
  const { batch } = buildBatch(entries, null, null, 1_700_000_000_000);
  assert.equal(batch.observations.some(o => o.kind === 'presence'), false);
  assert.equal(batch.observations.some(o => o.status != null), false);
  assert.equal(batch.observations.some(o => '_key' in o), false, '_key is internal and must not ship');
});

// ------------------------------------------------------- unit: mapping

test('asArray normalises the single-object-instead-of-list API quirk', () => {
  assert.deepEqual(asArray({ name: 'x' }), [{ name: 'x' }]);
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
});

test('largestImage prefers the biggest non-empty size', () => {
  const imgs = [
    { size: 'small', '#text': 's.png' },
    { size: 'extralarge', '#text': 'xl.png' },
    { size: 'large', '#text': 'l.png' },
  ];
  assert.equal(largestImage(imgs), 'xl.png');
  assert.equal(largestImage([{ size: 'medium', '#text': '' }]), null);
  assert.equal(largestImage(undefined), null);
});

test('toStatusObservation formats verbatim and refuses an untimestamped track', () => {
  const now = 1_700_000_000_000;
  const wrap = track => ({ recenttracks: { track } });

  const np = toStatusObservation(
    wrap([{ artist: { '#text': 'Boards of Canada' }, name: 'Roygbiv', '@attr': { nowplaying: 'true' } }]),
    'lastfm', 'x', now
  );
  assert.equal(np.kind, 'status');
  assert.equal(np.text, '♪ Boards of Canada — Roygbiv');
  assert.equal(np.ts, now);

  const past = toStatusObservation(
    wrap([{ artist: { '#text': 'Fishmans' }, name: 'Long Season', date: { uts: '1755630000' } }]),
    'lastfm', 'x', now
  );
  assert.equal(past.ts, 1755630000000);

  // neither nowplaying nor a date: there is no honest timestamp → emit nothing
  assert.equal(toStatusObservation(wrap([{ artist: { '#text': 'A' }, name: 'B' }]), 'lastfm', 'x', now), null);
  assert.equal(toStatusObservation(wrap([]), 'lastfm', 'x', now), null);
  assert.equal(toStatusObservation(null, 'lastfm', 'x', now), null);

  // no artist metadata: still verbatim, never padded with a guess
  const solo = toStatusObservation(wrap([{ name: 'Untitled', '@attr': { nowplaying: 'true' } }]), 'lastfm', 'x', now);
  assert.equal(solo.text, '♪ Untitled');
});

test('toStatusObservation is never a presence observation', () => {
  const o = toStatusObservation(
    { recenttracks: { track: { artist: { '#text': 'A' }, name: 'B', '@attr': { nowplaying: 'true' } } } },
    'lastfm', 'x', Date.now()
  );
  assert.equal(o.kind, 'status');
  assert.equal(o.status, undefined);
});

test('toPerson emits allow-listed fields only', () => {
  const p = toPerson({ name: 'x', realname: '', image: [] });
  assert.deepEqual(Object.keys(p).sort(), ['displayName', 'handle', 'source', 'sourceId']);
  assert.equal(toPerson({ realname: 'no name' }), null);
  assert.equal(toPerson(null), null);
});
