// test/matrix-orbit.test.js — the matrix-orbit external emitter.
// Runs the CLI offline (--dry-run --from-fixture) and pushes the emitted batch
// through the REAL core validator. Two things are load-bearing here: the
// presence state→enum mapping (no VRChat rings, ever) and graceful degradation
// on the many homeservers that serve no presence at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ingest from '../src/main/ingest.js';
import { freshDb } from './helpers.js';
import { mxcToThumbnail, toPerson, mapPresence, directContacts, buildBatch } from '../plugins/matrix-orbit/index.js';

const CLI = fileURLToPath(new URL('../plugins/matrix-orbit/index.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../plugins/matrix-orbit/fixture.sample.json', import.meta.url));
const FIXTURE_NO_PRESENCE = fileURLToPath(
  new URL('../plugins/matrix-orbit/fixture.presence-disabled.json', import.meta.url)
);
const SNAPSHOT_NAME = 'matrix-orbit.snapshot.fixture.json';

function runCli(args, { snapshot } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orbit-matrix-home-'));
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

const dryRun = (opts, fixture = FIXTURE) => runCli(['--from-fixture', fixture, '--dry-run'], opts);

// ---------------------------------------------------------------- CLI

test('matrix-orbit --dry-run --from-fixture emits a batch the core accepts', () => {
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
  assert.equal(batch.plugin, 'matrix-orbit');
  assert.deepEqual(ingest.PLUGIN_SOURCES['matrix-orbit'], ['matrix']);
  assert.ok(batch.emittedAt > 1_600_000_000_000);
});

test('every person is matrix-sourced, or the reserved (self, me)', () => {
  const batch = dryRun();
  const selves = batch.persons.filter(p => p.source === 'self');
  assert.equal(selves.length, 1);
  assert.equal(selves[0].sourceId, 'me');
  assert.equal(selves[0].handle, '@nerdrx:matrix.example');
  for (const p of batch.persons) assert.ok(p.source === 'matrix' || p.source === 'self', p.source);
});

test('kinds, statuses and timestamps are in-spec; no joinme/askme/busy', () => {
  const batch = dryRun();
  for (const o of batch.observations) {
    assert.ok(ingest.OBS_KINDS.has(o.kind), `kind ${o.kind}`);
    if (o.status != null) assert.ok(ingest.STATUS_VALUES.has(o.status), `status ${o.status}`);
    for (const forbidden of ['joinme', 'askme', 'busy']) assert.notEqual(o.status, forbidden);
    assert.equal(typeof o.ts, 'number');
    assert.ok(o.ts > 1_600_000_000_000 && o.ts < 4_000_000_000_000, 'ts is epoch ms');
  }
});

test('every observation subject is present in persons', () => {
  const batch = dryRun();
  const keys = new Set(batch.persons.map(p => p.source + ' ' + p.sourceId));
  for (const o of batch.observations) assert.ok(keys.has(o.source + ' ' + o.sourceId));
});

test('contacts come from m.direct only: no note-to-self, no room-less entry', () => {
  const batch = dryRun();
  const ids = batch.persons.filter(p => p.source === 'matrix').map(p => p.sourceId).sort();
  assert.deepEqual(ids, [
    '@aria:matrix.example',
    '@june:matrix.example',
    '@kaz:fedi.example',
    '@quiet:matrix.example',
  ]);
  // the operator's own DM-with-self is the `self` person, never a "friend"
  assert.equal(ids.includes('@nerdrx:matrix.example'), false);
  // a stale m.direct entry with an empty room list is not a contact
  assert.equal(ids.includes('@ghost:gone.example'), false);
});

test('the fixture presence states map onto the SPEC §2.2 enum exactly', () => {
  const batch = dryRun();
  const of = (id, kind) => batch.observations.filter(o => o.sourceId === id && o.kind === kind);

  // online → presence(online); its status_msg rides a separate status obs
  assert.equal(of('@aria:matrix.example', 'presence')[0].status, 'online');
  const ariaStatus = of('@aria:matrix.example', 'status')[0];
  assert.equal(ariaStatus.text, '🏖 away till the 20th — slow replies'); // verbatim
  assert.equal(ariaStatus.status, undefined, 'online carries no status ring');

  // unavailable → presence(online) + status(idle), NOT askme/joinme/busy
  assert.equal(of('@kaz:fedi.example', 'presence')[0].status, 'online');
  const kaz = of('@kaz:fedi.example', 'status')[0];
  assert.equal(kaz.status, 'idle');
  assert.equal(kaz.text, 'brb, coffee');

  // offline → presence(offline)
  assert.equal(of('@june:matrix.example', 'presence')[0].status, 'offline');

  // a homeserver-refused presence lookup produces nothing for that person
  assert.equal(of('@quiet:matrix.example', 'presence').length, 0);
  assert.equal(of('@quiet:matrix.example', 'status').length, 0);
  assert.ok(batch.persons.some(p => p.sourceId === '@quiet:matrix.example'), 'but they keep a person row');

  // the operator gets real presence — this is the heatmap's "me" axis
  assert.equal(batch.observations.find(o => o.source === 'self' && o.kind === 'presence').status, 'online');
});

test('last_active_ago produces a truthful past timestamp, not the poll time', () => {
  const before = Date.now();
  const batch = dryRun();
  const june = batch.observations.find(o => o.sourceId === '@june:matrix.example' && o.kind === 'presence');
  // fixture says last_active_ago = 86400000 (a day)
  assert.ok(june.ts <= before - 86_400_000 + 5_000 && june.ts >= before - 86_400_000 - 5_000, String(june.ts));
});

test('mxc:// avatars become https thumbnails on YOUR homeserver', () => {
  const batch = dryRun();
  const aria = batch.persons.find(p => p.sourceId === '@aria:matrix.example');
  assert.match(aria.avatarUrl, /^https:\/\/matrix\.example\/_matrix\/media\/v3\/thumbnail\//);
  // a remote user's media is still fetched through your own homeserver
  const kaz = batch.persons.find(p => p.sourceId === '@kaz:fedi.example');
  assert.match(kaz.avatarUrl, /^https:\/\/matrix\.example\/_matrix\/media\/v3\/thumbnail\/fedi\.example\//);
  // no avatar published → the field is omitted, never an empty string
  assert.equal(batch.persons.find(p => p.sourceId === '@june:matrix.example').avatarUrl, undefined);
});

test('a presence-disabled homeserver degrades to roster-only, not a failure', () => {
  const batch = dryRun(undefined, FIXTURE_NO_PRESENCE);
  assert.equal(batch.observations.length, 0);
  assert.equal(batch.persons.length, 3); // self + two contacts
  const t = freshDb();
  try {
    assert.equal(ingest.submit(batch).ok, true, 'a roster-only batch is still valid');
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------- snapshot diffing

test('presence is emitted on transition, not once per poll (idempotent)', () => {
  const contacts = {
    'self me': {
      displayName: 'nerdrx',
      avatarUrl:
        'https://matrix.example/_matrix/media/v3/thumbnail/matrix.example/SelfAvatarMediaId01?width=96&height=96&method=crop',
      handle: '@nerdrx:matrix.example',
      state: 'online|',
    },
    'matrix @aria:matrix.example': {
      displayName: 'Aria ✨',
      avatarUrl:
        'https://matrix.example/_matrix/media/v3/thumbnail/matrix.example/AriaAvatarMediaId02?width=96&height=96&method=crop',
      handle: '@aria:matrix.example',
      state: 'online|🏖 away till the 20th — slow replies',
    },
  };
  const batch = dryRun({ snapshot: { version: 1, contacts } });
  // aria's state is unchanged → nothing about aria at all
  assert.equal(batch.observations.some(o => o.sourceId === '@aria:matrix.example'), false);
  // self's state is unchanged → no repeat presence row either
  assert.equal(batch.observations.some(o => o.source === 'self'), false);
  // the other contacts are new on a non-first run → friend + their presence
  assert.equal(
    batch.observations.find(o => o.sourceId === '@kaz:fedi.example' && o.kind === 'friend').meta.state,
    'dm-opened'
  );
});

test('a closed DM is recorded, with the person re-upserted so the batch validates', () => {
  const contacts = {
    'matrix @gone:old.example': { displayName: 'Gone', avatarUrl: '', handle: '@gone:old.example', state: 'offline|' },
  };
  const batch = dryRun({ snapshot: { version: 1, contacts } });
  const gone = batch.observations.find(o => o.sourceId === '@gone:old.example');
  assert.equal(gone.kind, 'friend');
  assert.equal(gone.meta.state, 'dm-closed');
  assert.ok(batch.persons.some(p => p.sourceId === '@gone:old.example'));
  const t = freshDb();
  try {
    assert.equal(ingest.submit(batch).ok, true);
  } finally {
    t.cleanup();
  }
});

test('first run invents no dm-opened timestamps', () => {
  const batch = dryRun({ snapshot: null });
  assert.equal(batch.observations.filter(o => o.kind === 'friend').length, 0);
});

// ------------------------------------------------------- unit: mapping

test('mapPresence covers the whole Matrix enum and refuses to invent rings', () => {
  const now = 1_700_000_000_000;
  const M = (p, s = 'matrix', id = '@a:b') => mapPresence(p, s, id, now);

  assert.deepEqual(M({ presence: 'online' }), [
    { source: 'matrix', sourceId: '@a:b', kind: 'presence', status: 'online', ts: now },
  ]);

  assert.deepEqual(M({ presence: 'offline', last_active_ago: 60_000 }), [
    { source: 'matrix', sourceId: '@a:b', kind: 'presence', status: 'offline', ts: now - 60_000 },
  ]);

  assert.deepEqual(M({ presence: 'unavailable' }), [
    { source: 'matrix', sourceId: '@a:b', kind: 'presence', status: 'online', ts: now },
    { source: 'matrix', sourceId: '@a:b', kind: 'status', status: 'idle', ts: now },
  ]);

  // status_msg is verbatim and merged into the idle status row
  const away = M({ presence: 'unavailable', status_msg: '  brb  ' });
  assert.equal(away[1].text, 'brb');
  assert.equal(away[1].status, 'idle');

  // an all-whitespace status_msg is nothing, not an empty placeholder
  assert.equal(M({ presence: 'online', status_msg: '   ' }).length, 1);

  // Matrix has no DND/joinme/askme: an unknown state maps to NOTHING
  assert.deepEqual(M({ presence: 'busy' }), []);
  assert.deepEqual(M({ presence: 'dnd' }), []);
  assert.deepEqual(M({}), []);
  assert.deepEqual(M(null), []);

  // nothing this function can ever produce is a VRChat ring
  for (const state of ['online', 'unavailable', 'offline', 'busy', 'weird']) {
    for (const o of M({ presence: state, status_msg: 'x' })) {
      assert.ok(o.status == null || ['online', 'offline', 'idle'].includes(o.status), o.status);
    }
  }
});

test('directContacts reads only the operator own DM mapping', () => {
  const me = '@me:h.example';
  assert.deepEqual(
    directContacts({ '@b:h.example': ['!r'], '@a:h.example': ['!r2'] }, me),
    ['@a:h.example', '@b:h.example']
  );
  assert.deepEqual(directContacts({ [me]: ['!self'] }, me), [], 'note-to-self is not a contact');
  assert.deepEqual(directContacts({ '@a:h.example': [] }, me), [], 'no room → stale entry');
  assert.deepEqual(directContacts({ 'not-an-mxid': ['!r'] }, me), []);
  assert.deepEqual(directContacts(null, me), []);
});

test('mxcToThumbnail converts, or returns null rather than a broken URL', () => {
  assert.equal(
    mxcToThumbnail('mxc://matrix.example/AbCd123', 'https://hs.example'),
    'https://hs.example/_matrix/media/v3/thumbnail/matrix.example/AbCd123?width=96&height=96&method=crop'
  );
  assert.equal(mxcToThumbnail('https://not-mxc/x.png', 'https://hs.example'), null);
  assert.equal(mxcToThumbnail('mxc://onlyserver', 'https://hs.example'), null);
  assert.equal(mxcToThumbnail(undefined, 'https://hs.example'), null);
  assert.equal(mxcToThumbnail('mxc://a/b', null), null);
});

test('toPerson emits allow-listed fields only and rejects a non-MXID', () => {
  const p = toPerson('@a:h.example', {}, 'https://hs.example');
  assert.deepEqual(Object.keys(p).sort(), ['displayName', 'handle', 'source', 'sourceId']);
  assert.equal(p.displayName, '@a:h.example'); // no displayname → the MXID, not a placeholder
  assert.equal(toPerson('nobody', {}, 'https://hs.example'), null);
  assert.equal(toPerson('@nocolon', {}, 'https://hs.example'), null);
});

test('buildBatch keeps self out of the friend roster events', () => {
  const selfEntry = {
    person: { source: 'self', sourceId: 'me', handle: '@me:h', displayName: 'me' },
    presence: { presence: 'online' },
  };
  const { batch, nextSnapshot } = buildBatch([], selfEntry, { version: 1, contacts: {} }, 1_700_000_000_000);
  assert.equal(batch.observations.some(o => o.kind === 'friend'), false);
  assert.equal(batch.observations[0].kind, 'presence');
  assert.ok('self me' in nextSnapshot.contacts);
});
