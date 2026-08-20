// paths.js — the ONE config-dir resolver (SPEC §4, "Config-dir isolation").
//
// The bug this guards against is not hypothetical: a dev build and the installed
// build shared ~/.config/nx-orbit, so a plugin's test fixtures — invented Steam
// and Discord accounts — were written into a real person's friend roster. The
// rules that prevent it are (a) one helper, (b) read the environment at CALL
// time so a per-case override actually takes effect, and (c) every module that
// opens a file under the config dir goes through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';
import * as paths from '../src/main/paths.js';
import * as db from '../src/main/db.js';
import * as credentials from '../src/main/credentials.js';
import { defaultTokenPath } from '../src/main/ingest-server.js';

function withEnv(value, fn) {
  const prev = process.env.NX_ORBIT_CONFIG_DIR;
  if (value === undefined) delete process.env.NX_ORBIT_CONFIG_DIR;
  else process.env.NX_ORBIT_CONFIG_DIR = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NX_ORBIT_CONFIG_DIR;
    else process.env.NX_ORBIT_CONFIG_DIR = prev;
  }
}

test('configDir falls back to ~/.config/nx-orbit when unset', () => {
  withEnv(undefined, () => {
    assert.equal(paths.configDir(), join(homedir(), '.config', 'nx-orbit'));
  });
});

test('$NX_ORBIT_CONFIG_DIR is read at CALL time, not at module load', () => {
  const a = mkdtempSync(join(tmpdir(), 'orbit-paths-a-'));
  const b = mkdtempSync(join(tmpdir(), 'orbit-paths-b-'));
  try {
    // The module was imported long before either directory existed; if it had
    // captured the value at load, the second call would still answer the first.
    withEnv(a, () => assert.equal(paths.configDir(), a));
    withEnv(b, () => assert.equal(paths.configDir(), b));
    withEnv(undefined, () => assert.notEqual(paths.configDir(), a));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('an empty override is an accident, not a request for the cwd', () => {
  withEnv('', () => {
    assert.equal(paths.configDir(), join(homedir(), '.config', 'nx-orbit'));
  });
});

test('every persisted file hangs off the same directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-paths-'));
  try {
    withEnv(dir, () => {
      assert.equal(paths.dbPath(), join(dir, 'orbit.sqlite3'));
      assert.equal(paths.tokenPath(), join(dir, 'ingest.token'));
      assert.equal(paths.credentialsPath(), join(dir, 'credentials.json'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('db, credentials and the ingest server all resolve through the helper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-paths-'));
  try {
    withEnv(dir, () => {
      // No module may hand-roll join(homedir(), '.config', 'nx-orbit') again:
      // the override has to move all three at once, or the dev build writes into
      // the installed build's database exactly as it did before.
      assert.equal(db.defaultDbPath(), paths.dbPath());
      assert.equal(defaultTokenPath(), paths.tokenPath());
      assert.equal(credentials.configDir(), dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConfigDir creates the directory owner-only', { skip: platform() === 'win32' }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'orbit-paths-'));
  const dir = join(parent, 'nested', 'nx-orbit');
  try {
    withEnv(dir, () => {
      assert.equal(paths.ensureConfigDir(), dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      paths.ensureConfigDir(); // idempotent
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
