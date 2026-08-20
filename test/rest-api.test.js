// The versioned loopback REST API (docs/REST_API.md, SPEC §0.6/§1/§3).
// Covers the endpoint surface AND the security properties that make a
// loopback API safe to run on a desktop: bearer auth, DNS-rebinding defense,
// no CORS, body cap, and the "no person data ever leaves" rule.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startIngestServer, MAX_BODY_BYTES, schemaDescriptor } from '../src/main/ingest-server.js';
import * as ingest from '../src/main/ingest.js';
import * as db from '../src/main/db.js';
import { freshDb } from './helpers.js';

const TOKEN = 'test-token-abc';
let ctx, server, base, port;

beforeEach(async () => {
  ctx = freshDb();
  server = startIngestServer({ port: 0, token: TOKEN });
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(() => {
  server.close();
  ctx.cleanup();
});

const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

function goodBatch(over = {}) {
  return {
    plugin: 'vrcx',
    version: '1.0.0',
    emittedAt: Date.now(),
    persons: [{ source: 'vrcx', sourceId: 'usr_a', displayName: 'A' }],
    observations: [{ source: 'vrcx', sourceId: 'usr_a', kind: 'presence', status: 'online', ts: 1 }],
    ...over,
  };
}

const post = (path, body, headers = auth) =>
  fetch(base + path, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function counts() {
  const d = db.getDb();
  return {
    persons: d.prepare('SELECT COUNT(*) AS n FROM person').get().n,
    observations: d.prepare('SELECT COUNT(*) AS n FROM observation').get().n,
    log: d.prepare('SELECT COUNT(*) AS n FROM ingest_log').get().n,
  };
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('GET /api/v1/health needs no auth and reports version/schema/uptime', async () => {
  const res = await fetch(base + '/api/v1/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  assert.equal(body.schemaVersion, db.SCHEMA_VERSION);
  assert.equal(typeof body.uptimeSec, 'number');
  // §0.6: health must reveal nothing about the operator or their friends.
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'schemaVersion', 'uptimeSec', 'version']);
});

test('GET /health (unversioned alias) still returns exactly {ok:true}', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------------------------------------------------------------------------
// schema — must be derived from the validator's own constants
// ---------------------------------------------------------------------------

test('GET /api/v1/schema matches the exported ingest.js constants exactly', async () => {
  const res = await fetch(base + '/api/v1/schema', { headers: auth });
  assert.equal(res.status, 200);
  const s = await res.json();

  assert.deepEqual([...s.kinds].sort(), [...ingest.OBS_KINDS].sort());
  assert.deepEqual([...s.statuses].sort(), [...ingest.STATUS_VALUES].sort());
  assert.deepEqual([...s.personFields].sort(), [...ingest.PERSON_FIELDS].sort());
  assert.deepEqual([...s.observationFields].sort(), [...ingest.OBS_FIELDS].sort());
  assert.deepEqual(s.sources, ingest.PLUGIN_SOURCES);
  assert.deepEqual(s.self, { source: ingest.SELF_SOURCE, sourceId: ingest.SELF_ID });
  assert.equal(s.maxBodyBytes, MAX_BODY_BYTES);
  assert.equal(s.writeOnly, true);
  assert.equal(s.allOrNothing, true);
  assert.deepEqual(Object.keys(s.batch).sort(), [
    'emittedAt',
    'observations',
    'persons',
    'plugin',
    'version',
  ]);
  // The closed enum has no room for messages/scores (SPEC §2.2).
  for (const forbidden of ['message', 'dm', 'sentiment', 'score', 'location_precise'])
    assert.ok(!s.kinds.includes(forbidden), `kinds must not contain ${forbidden}`);
  assert.deepEqual(s, schemaDescriptor(MAX_BODY_BYTES));
});

test('GET /api/v1/schema requires auth', async () => {
  assert.equal((await fetch(base + '/api/v1/schema')).status, 401);
});

// ---------------------------------------------------------------------------
// validate — full validation, zero writes
// ---------------------------------------------------------------------------

test('POST /api/v1/validate accepts a good batch and writes NOTHING', async () => {
  const before = counts();
  const res = await post('/api/v1/validate', goodBatch());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { valid: true, would: { persons: 1, observations: 1 } });
  assert.deepEqual(counts(), before, 'validate must not touch person/observation/ingest_log');
});

test('POST /api/v1/validate rejects a bad kind with 422 and writes nothing', async () => {
  const before = counts();
  const batch = goodBatch();
  batch.observations[0].kind = 'message';
  const res = await post('/api/v1/validate', batch);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.valid, false);
  assert.ok(body.rejected.some((r) => r.part === 'observations' && r.field === 'kind'));
  assert.deepEqual(counts(), before);
});

test('POST /api/v1/validate rejects an unknown plugin', async () => {
  const res = await post('/api/v1/validate', goodBatch({ plugin: 'not-a-plugin' }));
  assert.equal(res.status, 422);
  assert.ok((await res.json()).rejected.some((r) => r.field === 'plugin'));
});

// ---------------------------------------------------------------------------
// ingest — versioned + legacy
// ---------------------------------------------------------------------------

test('POST /api/v1/ingest writes, and /ingest (legacy) writes too', async () => {
  const v1 = await post('/api/v1/ingest', goodBatch());
  assert.equal(v1.status, 200);
  assert.deepEqual((await v1.json()).accepted, { persons: 1, observations: 1 });

  const legacyBatch = goodBatch();
  legacyBatch.persons[0].sourceId = 'usr_b';
  legacyBatch.observations[0].sourceId = 'usr_b';
  const legacy = await post('/ingest', legacyBatch);
  assert.equal(legacy.status, 200);
  assert.deepEqual((await legacy.json()).accepted, { persons: 1, observations: 1 });

  const c = counts();
  assert.equal(c.persons, 3); // usr_a, usr_b + the seeded self row
  assert.equal(c.observations, 2);
});

test('re-POSTing the same history is idempotent (dedup over HTTP)', async () => {
  const batch = goodBatch();
  const first = await post('/api/v1/ingest', batch);
  assert.deepEqual((await first.json()).accepted, { persons: 1, observations: 1 });

  const second = await post('/api/v1/ingest', batch);
  assert.equal(second.status, 200);
  // Same 5-tuple → no new row; accepted.observations reports what was inserted.
  assert.deepEqual((await second.json()).accepted, { persons: 1, observations: 0 });
  assert.equal(counts().observations, 1);
});

test('a rejected batch writes nothing at all (all-or-nothing over HTTP)', async () => {
  const before = counts();
  const batch = goodBatch();
  batch.persons.push({ source: 'vrcx', sourceId: 'usr_z', displayName: 'Z' });
  batch.observations[0].kind = 'not_a_kind';
  const res = await post('/api/v1/ingest', batch);
  assert.equal(res.status, 422);
  assert.deepEqual(counts(), before);
});

// ---------------------------------------------------------------------------
// sources — telemetry about SOURCES, never about people
// ---------------------------------------------------------------------------

test('GET /api/v1/sources returns the registry plus last-run metadata, no person data', async () => {
  await post('/api/v1/ingest', goodBatch());
  const res = await fetch(base + '/api/v1/sources', { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.sources, ingest.PLUGIN_SOURCES);
  assert.deepEqual(body.self, { source: 'self', sourceId: 'me' });
  const run = body.lastRun.find((r) => r.plugin === 'vrcx');
  assert.ok(run, 'vrcx last run should be logged');
  assert.equal(run.version, '1.0.0');
  assert.equal(run.nPersons, 1);
  assert.equal(run.nObs, 1);
  assert.equal(typeof run.receivedAt, 'number');
  assert.deepEqual(Object.keys(run).sort(), ['nObs', 'nPersons', 'plugin', 'receivedAt', 'version']);

  // Hard rule: no endpoint may leak a person. The name we just ingested and
  // the person's id must not appear anywhere in this body.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('usr_a'), 'sources must not contain a person id');
  assert.ok(!/"A"/.test(raw), 'sources must not contain a display name');
});

test('there is no read endpoint for people (§0.6)', async () => {
  for (const path of ['/api/v1/people', '/api/v1/persons', '/api/v1/observations', '/api/v1/query']) {
    const res = await fetch(base + path, { headers: auth });
    assert.equal(res.status, 404, `${path} must not exist`);
  }
});

// ---------------------------------------------------------------------------
// security properties
// ---------------------------------------------------------------------------

test('401 on a missing or wrong bearer token', async () => {
  const noToken = await post('/api/v1/ingest', goodBatch(), { 'Content-Type': 'application/json' });
  assert.equal(noToken.status, 401);

  const wrong = await post('/api/v1/ingest', goodBatch(), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer wrong-token-xyz',
  });
  assert.equal(wrong.status, 401);

  // Length-mismatched token must 401, not crash timingSafeEqual into a 500.
  const short = await post('/api/v1/ingest', goodBatch(), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer x',
  });
  assert.equal(short.status, 401);

  const malformed = await post('/api/v1/ingest', goodBatch(), {
    'Content-Type': 'application/json',
    Authorization: TOKEN, // no "Bearer " prefix
  });
  assert.equal(malformed.status, 401);
  assert.equal(counts().observations, 0);
});

test('400 on malformed JSON (versioned), never a 500 or a stack trace', async () => {
  const res = await post('/api/v1/ingest', '{not json');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'invalid JSON' });
  assert.ok(!JSON.stringify(body).includes('src/main'), 'no internal paths in error bodies');
});

test('415 when Content-Type is not JSON', async () => {
  const res = await post('/api/v1/ingest', goodBatch(), {
    'Content-Type': 'text/plain',
    Authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 415);
  assert.equal(counts().observations, 0);
});

test('413 when the body exceeds the cap, and Content-Length cannot lie its way past it', async () => {
  const small = startIngestServer({ port: 0, token: TOKEN, maxBodyBytes: 1024 });
  await new Promise((r) => small.once('listening', r));
  const smallBase = `http://127.0.0.1:${small.address().port}`;
  try {
    const batch = goodBatch();
    batch.persons[0].bio = 'x'.repeat(4096);
    const res = await fetch(smallBase + '/api/v1/ingest', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(batch),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, 'payload too large');

    // A lying Content-Length (claims tiny, streams big) still hits the cap:
    // bytes are counted as they arrive.
    const lied = await new Promise((resolve, reject) => {
      import('node:http').then(({ default: http }) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: small.address().port,
            path: '/api/v1/ingest',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${TOKEN}`,
              'Transfer-Encoding': 'chunked', // no Content-Length at all
            },
          },
          (res2) => {
            res2.resume();
            resolve(res2.statusCode);
          }
        );
        req.on('error', reject);
        req.write('{"plugin":"vrcx","persons":[{"bio":"');
        req.write('y'.repeat(8192));
        req.end('"}]}');
      });
    });
    assert.equal(lied, 413);

    // The cap the server enforces is the cap it advertises.
    const s = await (await fetch(smallBase + '/api/v1/schema', { headers: auth })).json();
    assert.equal(s.maxBodyBytes, 1024);
  } finally {
    small.close();
  }
});

test('405 with a correct Allow header on the wrong method', async () => {
  const getIngest = await fetch(base + '/api/v1/ingest', { headers: auth });
  assert.equal(getIngest.status, 405);
  assert.equal(getIngest.headers.get('allow'), 'POST');

  const postSchema = await post('/api/v1/schema', {});
  assert.equal(postSchema.status, 405);
  assert.equal(postSchema.headers.get('allow'), 'GET');

  const deleteHealth = await fetch(base + '/api/v1/health', { method: 'DELETE' });
  assert.equal(deleteHealth.status, 405);
  assert.equal(deleteHealth.headers.get('allow'), 'GET');
});

test('404 JSON on an unknown path', async () => {
  const res = await fetch(base + '/api/v2/ingest', { headers: auth });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
  assert.match(res.headers.get('content-type'), /application\/json/);
});

test('DNS-rebinding: a non-loopback Host header is refused', async () => {
  const http = (await import('node:http')).default;
  const call = (hostHeader) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/ingest',
          method: 'POST',
          setHost: false,
          headers: {
            Host: hostHeader,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(goodBatch()));
    });

  // The rebinding case: evil.example resolves to 127.0.0.1, so the socket IS
  // loopback — only the Host header gives the attacker away.
  assert.equal(await call('evil.example'), 403);
  assert.equal(await call(`evil.example:${port}`), 403);
  assert.equal(await call('orbit.attacker.test'), 403);
  // …and a rebound request must not have written anything.
  assert.equal(counts().observations, 0);

  // Legitimate authorities still work.
  assert.equal(await call(`127.0.0.1:${port}`), 200);
  assert.equal(await call(`localhost:${port}`), 200);
});

test('no CORS header is ever sent, and OPTIONS preflight is refused', async () => {
  const paths = ['/health', '/api/v1/health', '/api/v1/schema', '/api/v1/ingest', '/ingest'];
  for (const p of paths) {
    const res = await fetch(base + p, { headers: auth });
    assert.equal(res.headers.get('access-control-allow-origin'), null, `${p} must not send CORS`);
    assert.equal(res.headers.get('access-control-allow-headers'), null);
    assert.equal(res.headers.get('access-control-allow-methods'), null);
  }

  // A browser preflight gets 405 (never 204 + CORS), so the page can't proceed.
  const pre = await fetch(base + '/api/v1/ingest', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(pre.status, 405);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  assert.ok(!(pre.headers.get('allow') ?? '').includes('OPTIONS'));
});

test('validation errors never echo a person name, handle, or bio', async () => {
  const secret = {
    displayName: 'Wilhelmina Von Testerson',
    handle: 'wilhelmina_secret_handle',
    bio: 'i live at 12 Privacy Lane and my cat is called Sniff',
    note: 'met at a party, likes DnB',
    pronouns: 'she/her',
  };
  const batch = {
    plugin: 'vrcx',
    version: '1.0.0',
    emittedAt: Date.now(),
    persons: [
      { source: 'discord', sourceId: 'usr_leak', ...secret }, // wrong source for this plugin
      { source: 'self', sourceId: 'not-me', displayName: 'Impersonator McFake' }, // §0.6 violation
    ],
    observations: [
      {
        source: 'vrcx',
        sourceId: 'usr_ghost',
        kind: 'sentiment', // outside the enum
        ts: 1,
        text: 'a private status message nobody else should see',
        place: 'Secret World Name',
      },
    ],
  };

  for (const path of ['/api/v1/ingest', '/api/v1/validate', '/ingest']) {
    const res = await post(path, batch);
    assert.equal(res.status, 422);
    const raw = JSON.stringify(await res.json());
    for (const leak of [
      secret.displayName,
      secret.handle,
      secret.bio,
      secret.note,
      secret.pronouns,
      'Impersonator McFake',
      'a private status message nobody else should see',
      'Secret World Name',
    ]) {
      assert.ok(!raw.includes(leak), `${path} response leaked "${leak}"`);
    }
    // It still says something useful: which record, which field.
    const body = JSON.parse(raw);
    assert.ok(body.rejected.some((r) => r.part === 'persons' && r.index === 0 && r.field === 'source'));
    assert.ok(body.rejected.some((r) => r.part === 'observations' && r.field === 'kind'));
  }
});

test('a request can never reach SQL or the filesystem directly', async () => {
  // Path traversal, a SQL-shaped path, and a SQL-shaped plugin name all end
  // as ordinary 404/422s — everything goes through ingest.submit.
  const traversal = await fetch(base + '/api/v1/../../etc/passwd', { headers: auth });
  assert.ok([400, 404].includes(traversal.status));

  const sqlPath = await fetch(base + "/api/v1/sources';DROP%20TABLE%20person;--", { headers: auth });
  assert.equal(sqlPath.status, 404);

  const sqlPlugin = await post('/api/v1/ingest', goodBatch({ plugin: "vrcx'; DROP TABLE person;--" }));
  assert.equal(sqlPlugin.status, 422);
  assert.ok(db.getDb().prepare("SELECT name FROM sqlite_master WHERE name='person'").get());
});
