// credentials.js — the 0600 secret store (SPEC §0.2). Round-trips, clears,
// asserts the file is owner-only, and proves redact() never leaks the full key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import * as credentials from '../src/main/credentials.js';

// Point the store at a throwaway dir for the duration of a test body.
function withTempConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-cred-'));
  const prev = process.env.NX_ORBIT_CONFIG_DIR;
  process.env.NX_ORBIT_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.NX_ORBIT_CONFIG_DIR;
    else process.env.NX_ORBIT_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('unconfigured source reads back as null', () => {
  withTempConfig(() => {
    assert.equal(credentials.getSourceConfig('steam'), null);
    assert.equal(credentials.redact('steam'), null);
  });
});

test('set/get round-trips the full config in-process', () => {
  withTempConfig(() => {
    const cfg = { apiKey: 'ABCDEF0123456789ABCDEF0123456789', steamId: '76561198000000042', account: 'nova' };
    credentials.setSourceConfig('steam', cfg);
    assert.deepEqual(credentials.getSourceConfig('steam'), cfg);
  });
});

test('clear removes only the named source, leaving others', () => {
  withTempConfig(() => {
    credentials.setSourceConfig('steam', { apiKey: 'k1', steamId: '1' });
    credentials.setSourceConfig('other', { apiKey: 'k2' });
    assert.equal(credentials.clearSourceConfig('steam'), true);
    assert.equal(credentials.getSourceConfig('steam'), null);
    assert.deepEqual(credentials.getSourceConfig('other'), { apiKey: 'k2' });
    // clearing an absent source is a harmless no-op
    assert.equal(credentials.clearSourceConfig('steam'), false);
  });
});

test('the credentials file is created 0600 (owner-only)', { skip: platform() === 'win32' }, () => {
  withTempConfig((dir) => {
    credentials.setSourceConfig('steam', { apiKey: 'secret', steamId: '1' });
    const p = join(dir, 'credentials.json');
    assert.ok(existsSync(p));
    const mode = statSync(p).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  });
});

test('redact never leaks the full key — only presence + last 4', () => {
  withTempConfig(() => {
    const apiKey = 'TOPSECRETKEY9999ABCD';
    credentials.setSourceConfig('steam', { apiKey, steamId: '76561198000000042', account: 'nova' });
    const r = credentials.redact('steam');
    assert.equal(r.apiKeyPresent, true);
    assert.equal(r.apiKeyLast4, '…ABCD');
    assert.equal(r.account, 'nova');
    assert.equal(r.steamId, '76561198000000042');
    // The full secret must not appear anywhere in the redacted projection.
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(apiKey), 'redacted view must not contain the full key');
    assert.ok(!serialized.includes('TOPSECRETKEY'), 'redacted view must not contain the key body');
    // and there is no apiKey field at all
    assert.equal('apiKey' in r, false);
  });
});

test('a corrupt store degrades to empty rather than throwing', () => {
  withTempConfig((dir) => {
    const p = join(dir, 'credentials.json');
    // Write garbage directly.
    writeFileSync(p, 'not json {{{');
    assert.equal(credentials.getSourceConfig('steam'), null);
  });
});
