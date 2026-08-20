// steam-orbit: the personastate → SPEC §2.2 mapping, charter enforcement, and a
// SPEC §3 schema validator written independently of the core (so the plugin is
// checked against the written spec, not just against src/main/ingest.js — then
// against ingest.submit() too, for good measure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ingest from '../src/main/ingest.js';
import { freshDb } from './helpers.js';
import {
  buildBatch,
  chunk,
  PERSONA_STATE,
  SUMMARIES_CHUNK,
} from '../plugins/steam-orbit/index.js';

const CLI = fileURLToPath(new URL('../plugins/steam-orbit/index.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../plugins/steam-orbit/fixture.sample.json', import.meta.url));
const RAW = JSON.parse(
  execFileSync(process.execPath, [CLI, '--dry-run', '--from-fixture', FIXTURE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
);

// ---------------------------------------------------------------------------
// A SPEC §3 validator transcribed from SPEC.md (deliberately not imported from
// the core): allow-listed fields, closed enums, declared source, self=me, and
// "no observation about a person who isn't in the batch".
// ---------------------------------------------------------------------------
const OBS_KINDS = new Set(['presence', 'status', 'location', 'bio', 'nick', 'avatar', 'friend']);
const STATUS_VALUES = new Set(['online', 'active', 'idle', 'joinme', 'askme', 'busy', 'offline']);
const PERSON_FIELDS = new Set([
  'source', 'sourceId', 'handle', 'displayName', 'avatarUrl',
  'birthday', 'pronouns', 'bio', 'note', 'links',
]);
const OBS_FIELDS = new Set(['source', 'sourceId', 'kind', 'ts', 'status', 'text', 'place', 'meta']);

function validateBatch(batch, plugin, declaredSources) {
  const errs = [];
  const declared = new Set(declaredSources);
  if (batch.plugin !== plugin) errs.push(`plugin is "${batch.plugin}", expected "${plugin}"`);
  if (typeof batch.version !== 'string' || !batch.version) errs.push('missing version');
  if (typeof batch.emittedAt !== 'number') errs.push('missing emittedAt');
  if (!Array.isArray(batch.persons)) errs.push('persons is not an array');
  if (!Array.isArray(batch.observations)) errs.push('observations is not an array');
  if (errs.length) return errs;

  const keys = new Set();
  batch.persons.forEach((p, i) => {
    for (const k of Object.keys(p)) if (!PERSON_FIELDS.has(k)) errs.push(`persons[${i}]: field "${k}" not in SPEC §2.1`);
    if (!p.source) errs.push(`persons[${i}]: missing source`);
    if (!p.sourceId) errs.push(`persons[${i}]: missing sourceId`);
    if (p.source === 'self') {
      if (p.sourceId !== 'me') errs.push(`persons[${i}]: self person must be sourceId "me"`);
    } else if (!declared.has(p.source)) {
      errs.push(`persons[${i}]: source "${p.source}" not declared by ${plugin}`);
    }
    if (p.birthday != null && !/^(\d{4}-)?\d{2}-\d{2}$/.test(p.birthday))
      errs.push(`persons[${i}]: birthday "${p.birthday}" is not MM-DD or YYYY-MM-DD`);
    keys.add(p.source + ' ' + p.sourceId);
  });

  batch.observations.forEach((o, i) => {
    for (const k of Object.keys(o)) if (!OBS_FIELDS.has(k)) errs.push(`observations[${i}]: field "${k}" not in SPEC §2.2`);
    if (!OBS_KINDS.has(o.kind)) errs.push(`observations[${i}]: kind "${o.kind}" not in the enum`);
    if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) errs.push(`observations[${i}]: bad ts`);
    if (o.status != null && !STATUS_VALUES.has(o.status))
      errs.push(`observations[${i}]: status "${o.status}" not in the enum`);
    if (o.text != null && typeof o.text !== 'string') errs.push(`observations[${i}]: text must be a string`);
    if (o.place != null && typeof o.place !== 'string') errs.push(`observations[${i}]: place must be a string`);
    if (!keys.has(o.source + ' ' + o.sourceId))
      errs.push(`observations[${i}]: about a person not in the batch (${o.source}:${o.sourceId})`);
  });
  return errs;
}

const obsFor = (id, kind) => RAW.observations.filter((o) => o.sourceId === id && o.kind === kind);
const personFor = (id) => RAW.persons.find((p) => p.sourceId === id);

// ---------------------------------------------------------------------------

test('the fixture dry-run emits a SPEC §3-valid batch', () => {
  assert.deepEqual(validateBatch(RAW, 'steam-orbit', ['steam']), []);
  assert.equal(RAW.plugin, 'steam-orbit');
  assert.ok(RAW.persons.length > 0 && RAW.observations.length > 0);
});

test('the core registry declares the sources this plugin writes', () => {
  assert.deepEqual(ingest.PLUGIN_SOURCES['steam-orbit'], ['steam']);
  const sources = new Set(RAW.persons.map((p) => p.source));
  assert.deepEqual([...sources].sort(), ['self', 'steam']);
});

test('the batch is accepted by the real core validator', () => {
  const ctx = freshDb();
  try {
    const res = ingest.submit(RAW);
    assert.equal(res.ok, true, JSON.stringify(res.rejected));
    assert.equal(res.accepted.persons, RAW.persons.length);
    assert.equal(res.accepted.observations, RAW.observations.length);
  } finally {
    ctx.cleanup();
  }
});

test('personastate maps to the SPEC §2.2 enum and never invents joinme/askme', () => {
  // 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 trade, 6 play
  const expected = {
    '76561198000000010': { presence: 'offline', status: null }, // 0
    '76561198000000011': { presence: 'online', status: null },  // 1
    '76561198000000012': { presence: 'online', status: 'busy' }, // 2
    '76561198000000013': { presence: 'online', status: 'idle' }, // 3 away
    '76561198000000014': { presence: 'online', status: 'idle' }, // 4 snooze
    '76561198000000015': { presence: 'online', status: null },  // 5 looking to trade
    '76561198000000016': { presence: 'online', status: null },  // 6 looking to play
  };
  for (const [id, want] of Object.entries(expected)) {
    const presence = obsFor(id, 'presence');
    assert.equal(presence.length, 1, `${id} should have exactly one presence obs`);
    assert.equal(presence[0].status, want.presence, `${id} presence`);
    const status = obsFor(id, 'status');
    if (want.status) {
      assert.equal(status.length, 1, `${id} should have a status obs`);
      assert.equal(status[0].status, want.status);
      assert.equal(status[0].text, undefined); // Steam has no status text
    } else {
      assert.equal(status.length, 0, `${id} must NOT get a status obs`);
    }
  }
  // SPEC §2.2: a plugin with no true equivalent omits `status` rather than faking.
  const faked = RAW.observations.filter((o) => o.status === 'joinme' || o.status === 'askme');
  assert.deepEqual(faked, []);
  // `active` is likewise not a Steam concept.
  assert.deepEqual(RAW.observations.filter((o) => o.status === 'active'), []);
});

test('the mapping table covers exactly personastate 0-6', () => {
  assert.deepEqual(Object.keys(PERSONA_STATE), ['0', '1', '2', '3', '4', '5', '6']);
  for (const [state, m] of Object.entries(PERSONA_STATE)) {
    assert.ok(STATUS_VALUES.has(m.presence), `state ${state} presence`);
    if (m.status) assert.ok(['busy', 'idle'].includes(m.status), `state ${state} status`);
  }
});

test('gameextrainfo becomes a location observation with the game as `place`', () => {
  const l = obsFor('76561198000000011', 'location');
  assert.equal(l.length, 1);
  assert.equal(l[0].place, 'Deep Rock Galactic');
  assert.equal(obsFor('76561198000000016', 'location')[0].place, 'Left 4 Dead 2');
  // Friends who published no game get no location observation.
  assert.equal(obsFor('76561198000000012', 'location').length, 0);
});

test('the reserved `self` person is the operator, and the operator is not a friend row', () => {
  const selves = RAW.persons.filter((p) => p.source === 'self');
  assert.equal(selves.length, 1);
  assert.deepEqual(selves[0], { source: 'self', sourceId: 'me', handle: 'you', displayName: '(you)' });
  // The operator's own steamid must never appear as a `steam` person.
  assert.equal(personFor('76561198000000001'), undefined);
  // …but their presence IS emitted — it is the heatmap's "me" axis (SPEC §5).
  const selfPresence = RAW.observations.filter((o) => o.source === 'self' && o.kind === 'presence');
  assert.equal(selfPresence.length, 1);
  assert.equal(selfPresence[0].status, 'online');
  assert.equal(
    RAW.observations.find((o) => o.source === 'self' && o.kind === 'location').place,
    'Half-Life: Alyx'
  );
});

test('friends-only: a pending request (relationship != friend) is never emitted', () => {
  assert.equal(personFor('76561198000000099'), undefined);
  assert.equal(RAW.observations.filter((o) => o.sourceId === '76561198000000099').length, 0);
});

test('a private profile yields a person but no invented presence', () => {
  const p = personFor('76561198000000017');
  assert.ok(p, 'the friend is still on your list, so they are still a person');
  assert.equal(p.displayName, 'private_pangolin');
  assert.equal(obsFor('76561198000000017', 'presence').length, 0);
  assert.equal(obsFor('76561198000000017', 'status').length, 0);
});

test('realname / timecreated are dropped, not smuggled', () => {
  const json = JSON.stringify(RAW);
  assert.ok(!json.includes('Should Never Be Emitted'));
  assert.ok(!json.includes('Also Dropped'));
  assert.ok(!/realname|timecreated|communityvisibilitystate/i.test(json));
});

test('friend observations carry Steam\'s real friend_since timestamp', () => {
  const f = obsFor('76561198000000010', 'friend');
  assert.equal(f.length, 1);
  assert.equal(f[0].ts, 1520000000 * 1000);
  assert.deepEqual(f[0].meta, { state: 'added' });
  // friend_since 0 (unknown) falls back to now rather than to the epoch.
  assert.ok(obsFor('76561198000000017', 'friend')[0].ts > 1.7e12);
});

// ------------------------------------------------------- snapshot diffing

const FX = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const friends = FX.friends.friendslist.friends
  .filter((f) => f.relationship === 'friend')
  .map((f) => ({ steamid: f.steamid, friendSince: f.friend_since ? f.friend_since * 1000 : null }));
const players = FX.summaries.response.players;
const args = { friends, players, steamid: FX.steamid, now: 1_700_000_000_000 };

test('a re-run with an unchanged snapshot emits no change events', () => {
  const first = buildBatch(args);
  const second = buildBatch({ ...args, snapshot: first.nextSnapshot });
  assert.equal(second.batch.observations.filter((o) => o.kind === 'friend').length, 0);
  assert.equal(second.batch.observations.filter((o) => o.kind === 'nick').length, 0);
  assert.equal(second.batch.observations.filter((o) => o.kind === 'avatar').length, 0);
  // presence/status/location ARE re-emitted every run: that is the heatmap feed.
  assert.ok(second.batch.observations.some((o) => o.kind === 'presence'));
  assert.deepEqual(validateBatch(second.batch, 'steam-orbit', ['steam']), []);
});

test('a renamed / re-avatared friend produces nick + avatar observations', () => {
  const first = buildBatch(args);
  const snapshot = structuredClone(first.nextSnapshot);
  snapshot['76561198000000011'] = { name: 'old_otter', avatar: 'https://example.invalid/old.jpg', since: null };
  const { batch } = buildBatch({ ...args, snapshot });
  const nick = batch.observations.find((o) => o.kind === 'nick');
  assert.equal(nick.text, 'online_otter');
  assert.deepEqual(nick.meta, { previous: 'old_otter' });
  assert.ok(batch.observations.some((o) => o.kind === 'avatar' && o.sourceId === '76561198000000011'));
  assert.deepEqual(validateBatch(batch, 'steam-orbit', ['steam']), []);
});

test('an unfriended person yields a friend:removed obs AND a person row for it', () => {
  const first = buildBatch(args);
  const snapshot = { ...first.nextSnapshot, '76561198000000098': { name: 'gone_gopher', avatar: null, since: null } };
  const { batch } = buildBatch({ ...args, snapshot });
  const removed = batch.observations.find((o) => o.sourceId === '76561198000000098');
  assert.deepEqual(removed.meta, { state: 'removed' });
  // SPEC §3: no observation about an unknown person — so the person is re-emitted.
  assert.deepEqual(validateBatch(batch, 'steam-orbit', ['steam']), []);
});

test('GetPlayerSummaries is batched at Valve\'s documented 100-id limit', () => {
  assert.equal(SUMMARIES_CHUNK, 100);
  const ids = Array.from({ length: 250 }, (_, i) => String(i));
  const groups = chunk(ids, SUMMARIES_CHUNK);
  assert.deepEqual(groups.map((g) => g.length), [100, 100, 50]);
  assert.equal(groups.flat().length, 250);
});
