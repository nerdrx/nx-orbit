// Shared test helpers: fresh temp DB per test, small builders.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../src/main/db.js';

export function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-test-'));
  const path = join(dir, 'orbit.sqlite3');
  db.open(path);
  return {
    path,
    dir,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function person(over = {}) {
  return {
    source: 'vrcx',
    sourceId: 'usr_' + Math.random().toString(36).slice(2),
    handle: 'friend',
    displayName: 'Friend',
    ...over,
  };
}

export function obs(over = {}) {
  return {
    source: 'vrcx',
    sourceId: 'usr_1',
    kind: 'presence',
    status: 'online',
    ts: Date.now(),
    ...over,
  };
}
