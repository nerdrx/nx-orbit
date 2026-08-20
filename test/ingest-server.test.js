// Loopback ingest HTTP endpoint (SPEC §1, PLUGIN_GUIDELINES B).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startIngestServer } from '../src/main/ingest-server.js';
import { freshDb } from './helpers.js';

const TOKEN = 'test-token-abc';
let ctx, server, base;

beforeEach(async () => {
  ctx = freshDb();
  server = startIngestServer({ port: 0, token: TOKEN });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  server.close();
  ctx.cleanup();
});

function goodBatch() {
  return {
    plugin: 'vrcx',
    version: '1.0.0',
    emittedAt: Date.now(),
    persons: [{ source: 'vrcx', sourceId: 'usr_a', displayName: 'A' }],
    observations: [{ source: 'vrcx', sourceId: 'usr_a', kind: 'presence', status: 'online', ts: 1 }],
  };
}

test('GET /health → 200 {ok:true}', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('POST /ingest without token → 401', async () => {
  const res = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(goodBatch()),
  });
  assert.equal(res.status, 401);
});

test('POST /ingest with valid token+batch → 200 accepted', async () => {
  const res = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(goodBatch()),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.accepted, { persons: 1, observations: 1 });
});

test('POST /ingest with a bad kind → 422 rejected', async () => {
  const batch = goodBatch();
  batch.observations[0].kind = 'message';
  const res = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(batch),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.rejected.some((r) => r.field === 'kind'));
});

test('POST /ingest with invalid JSON → 422', async () => {
  const res = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: '{not json',
  });
  assert.equal(res.status, 422);
});
