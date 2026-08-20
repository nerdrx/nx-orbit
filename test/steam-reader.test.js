// steam.js — the in-process Steam reader (SPEC §8). Proves collect() produces a
// schema-valid batch the REAL core accepts, that profile-link/vanity/SteamID64
// resolution picks the right path (vanity mocked, never the network), and that
// validate() maps a private-friends-list response to the actionable fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ingest from '../src/main/ingest.js';
import * as credentials from '../src/main/credentials.js';
import { freshDb } from './helpers.js';
import { SteamHttpError } from '../plugins/steam-orbit/index.js';
import { collect, validate, resolveSteamId, meta } from '../src/main/plugins/steam.js';

const FIXTURE = fileURLToPath(new URL('../plugins/steam-orbit/fixture.sample.json', import.meta.url));
const FX = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// Build the { friends, players } shape fetchLive would return, straight from the
// saved fixture — so collect() runs its full path with no network.
function fixtureFetch() {
  const friends = FX.friends.friendslist.friends
    .filter((f) => f.relationship === 'friend')
    .map((f) => ({ steamid: f.steamid, friendSince: f.friend_since ? f.friend_since * 1000 : null }));
  const players = FX.summaries.response.players;
  return async () => ({ friends, players });
}

// Give each test an isolated credentials dir so setSourceConfig doesn't touch the
// real ~/.config/nx-orbit.
function withTempConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-steamr-'));
  const prev = process.env.NX_ORBIT_CONFIG_DIR;
  process.env.NX_ORBIT_CONFIG_DIR = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.NX_ORBIT_CONFIG_DIR;
    else process.env.NX_ORBIT_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

test('meta declares the steam source and matches the reader contract', () => {
  assert.deepEqual(meta, { name: 'steam', version: '1.0.0', source: 'steam' });
});

test('an unconfigured reader is idle — an empty, valid batch, no error', async () => {
  await withTempConfig(async () => {
    const batch = await collect({});
    assert.deepEqual(batch.persons, []);
    assert.deepEqual(batch.observations, []);
    assert.equal(batch.plugin, 'steam-orbit'); // the name ingest declares for `steam`
  });
});

test('collect() against the fixture yields a batch the real core accepts', async () => {
  await withTempConfig(async () => {
    credentials.setSourceConfig('steam', { apiKey: 'k', steamId: FX.steamid });
    const batch = await collect({ fetchLive: fixtureFetch() });

    // Shape: declared plugin, the `steam` + reserved `self` sources only.
    assert.equal(batch.plugin, 'steam-orbit');
    const srcSet = new Set(batch.persons.map((p) => p.source));
    assert.deepEqual([...srcSet].sort(), ['self', 'steam']);

    // The reserved self person is the operator, keyed (self, me) — never a friend row.
    const selves = batch.persons.filter((p) => p.source === 'self');
    assert.equal(selves.length, 1);
    assert.equal(selves[0].sourceId, 'me');
    assert.equal(batch.persons.find((p) => p.sourceId === FX.steamid), undefined);

    // Friends-only: the pending request (relationship != friend) never appears.
    assert.equal(batch.persons.find((p) => p.sourceId === '76561198000000099'), undefined);

    // No faked rings, and every status/kind is in the SPEC enum.
    const KINDS = new Set(['presence', 'status', 'location', 'bio', 'nick', 'avatar', 'friend']);
    const STAT = new Set(['online', 'active', 'idle', 'joinme', 'askme', 'busy', 'offline']);
    for (const o of batch.observations) {
      assert.ok(KINDS.has(o.kind), `kind ${o.kind}`);
      if (o.status != null) assert.ok(STAT.has(o.status), `status ${o.status}`);
    }
    assert.equal(batch.observations.filter((o) => o.status === 'joinme' || o.status === 'askme' || o.status === 'active').length, 0);

    // A private profile is still a person, but gets no invented presence.
    const priv = batch.persons.find((p) => p.sourceId === '76561198000000017');
    assert.ok(priv);
    assert.equal(batch.observations.filter((o) => o.sourceId === '76561198000000017' && (o.kind === 'presence' || o.kind === 'status')).length, 0);

    // realname / timecreated are never smuggled anywhere in the batch.
    const json = JSON.stringify(batch);
    assert.ok(!/realname|timecreated|communityvisibilitystate/i.test(json));
    assert.ok(!json.includes('Should Never Be Emitted'));

    // Push it through the REAL core validator + writer on a temp DB.
    const ctx = freshDb();
    try {
      const res = ingest.submit(batch);
      assert.equal(res.ok, true, JSON.stringify(res.rejected));
      assert.equal(res.accepted.persons, batch.persons.length);
    } finally {
      ctx.cleanup();
    }
  });
});

test('collect() survives a Steam fetch failure — logs, emits an empty batch', async () => {
  await withTempConfig(async () => {
    credentials.setSourceConfig('steam', { apiKey: 'k', steamId: FX.steamid });
    const logs = [];
    const batch = await collect({
      log: (m) => logs.push(m),
      fetchLive: async () => { throw new SteamHttpError(403, '', 'GetFriendList'); },
    });
    assert.deepEqual(batch.persons, []);
    assert.deepEqual(batch.observations, []);
    assert.ok(logs.some((m) => /steam: fetch failed/.test(m)));
  });
});

// ------------------------------------------------------- profile resolution

test('resolveSteamId: a bare SteamID64 is used as-is, no API call', async () => {
  let called = false;
  const apiGet = async () => { called = true; return {}; };
  const id = await resolveSteamId('76561198000000042', 'key', { apiGet });
  assert.equal(id, '76561198000000042');
  assert.equal(called, false, 'a 17-digit id must not trigger a vanity lookup');
});

test('resolveSteamId: a /profiles/ URL yields the embedded id, no API call', async () => {
  let called = false;
  const apiGet = async () => { called = true; return {}; };
  const id = await resolveSteamId('https://steamcommunity.com/profiles/76561198000000042/', 'key', { apiGet });
  assert.equal(id, '76561198000000042');
  assert.equal(called, false);
});

test('resolveSteamId: a /id/<vanity> URL resolves via ResolveVanityURL (mocked)', async () => {
  const calls = [];
  const apiGet = async (url, what) => {
    calls.push({ url, what });
    assert.match(url, /ResolveVanityURL/);
    assert.match(url, /vanityurl=novanav/);
    return { response: { success: 1, steamid: '76561198000000042' } };
  };
  const id = await resolveSteamId('https://steamcommunity.com/id/novanav', 'key', { apiGet });
  assert.equal(id, '76561198000000042');
  assert.equal(calls.length, 1);
});

test('resolveSteamId: a bare vanity name resolves via ResolveVanityURL (mocked)', async () => {
  const apiGet = async () => ({ response: { success: 1, steamid: '76561198000000042' } });
  const id = await resolveSteamId('novanav', 'key', { apiGet });
  assert.equal(id, '76561198000000042');
});

test('resolveSteamId: an unknown vanity (success 42) resolves to null', async () => {
  const apiGet = async () => ({ response: { success: 42 } });
  assert.equal(await resolveSteamId('ghostname', 'key', { apiGet }), null);
});

// --------------------------------------------------------------- validate

// A transport that answers each Steam endpoint by name.
function fakeApi({ summariesPlayers, friendList, friendThrow }) {
  return async (url, what) => {
    if (what === 'GetPlayerSummaries') return { response: { players: summariesPlayers } };
    if (what === 'GetFriendList') {
      if (friendThrow) throw friendThrow;
      return friendList;
    }
    throw new Error('unexpected endpoint ' + what);
  };
}

test('validate: happy path returns account + friendCount + resolved id', async () => {
  const apiGet = fakeApi({
    summariesPlayers: [{ steamid: '76561198000000042', personaname: 'nova_navigator' }],
    friendList: { friendslist: { friends: [
      { steamid: '1', relationship: 'friend' },
      { steamid: '2', relationship: 'friend' },
    ] } },
  });
  const res = await validate({ apiKey: 'key', steamId: '76561198000000042' }, { apiGet });
  assert.deepEqual(res, { ok: true, account: 'nova_navigator', friendCount: 2, steamId: '76561198000000042' });
});

test('validate: a private (403) friends list maps to the actionable Public-list fix', async () => {
  const apiGet = fakeApi({
    summariesPlayers: [{ steamid: '76561198000000042', personaname: 'nova' }],
    friendThrow: new SteamHttpError(403, '', 'GetFriendList'),
  });
  const res = await validate({ apiKey: 'key', steamId: '76561198000000042' }, { apiGet });
  assert.equal(res.ok, false);
  assert.match(res.reason, /My Friends List/);
  assert.match(res.reason, /Public/);
});

test('validate: an empty friends list is treated as the same private-list case', async () => {
  const apiGet = fakeApi({
    summariesPlayers: [{ steamid: '76561198000000042', personaname: 'nova' }],
    friendList: { friendslist: { friends: [] } },
  });
  const res = await validate({ apiKey: 'key', steamId: '76561198000000042' }, { apiGet });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Public/);
});

test('validate: missing key / profile is rejected before any network call', async () => {
  const apiGet = async () => { throw new Error('should not be called'); };
  assert.equal((await validate({ apiKey: '', steamId: 'x' }, { apiGet })).ok, false);
  assert.equal((await validate({ apiKey: 'k', steamId: '' }, { apiGet })).ok, false);
});
