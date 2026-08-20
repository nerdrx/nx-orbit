// src/main/ingest-server.js — the loopback REST API (SPEC §1/§3,
// docs/REST_API.md, PLUGIN_GUIDELINES "B. External emitter"). Bound to
// 127.0.0.1, bearer token in ~/.config/nx-orbit/ingest.token. Pure
// node:http/node:crypto — no electron.
//
// It is deliberately WRITE-ONLY (SPEC §0.6: Orbit "never exposes an API for a
// third party to query your friends"). Sources push records in; there is no
// endpoint — none, by design — that reads person data back out, and error
// bodies never echo a person's name/handle/bio either (see scrubReasons).

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as ingest from './ingest.js';
import * as paths from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Largest accepted request body. Named + exported so /api/v1/schema can
// advertise it and a plugin can chunk its re-scan below the limit.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// The app version reported by /api/v1/health. Read once, never fatal.
function appVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const APP_VERSION = appVersion();

// Resolved through paths.js, the one config-dir helper (SPEC §4): the token must
// live beside the database it authorises writes into, so a build pointed at an
// isolated $NX_ORBIT_CONFIG_DIR mints its own token instead of borrowing the
// installed build's.
export function defaultTokenPath() {
  return paths.tokenPath();
}

// Read the ingest token, generating one on first run (0600).
export function getOrCreateToken(tokenPath = defaultTokenPath()) {
  if (existsSync(tokenPath)) {
    const t = readFileSync(tokenPath, 'utf8').trim();
    if (t) return t;
  }
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return token;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req) {
  const addr = req.socket?.remoteAddress;
  return addr != null && LOOPBACK.has(addr);
}

// DNS-rebinding defense. A malicious page on evil.example can make the browser
// resolve its own name to 127.0.0.1 and POST here; the socket is then genuinely
// loopback, so remoteAddress can't tell us apart. The Host header can: the
// browser sends the name it dialled. Only literal loopback authorities pass.
const HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

function hostOk(req) {
  const h = req.headers['host'];
  return typeof h === 'string' && HOST_RE.test(h.trim());
}

function bearerOk(header, token) {
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  // timingSafeEqual throws on length mismatch — guard, then compare in
  // constant time so a wrong token leaks nothing through response latency.
  return a.length === b.length && timingSafeEqual(a, b);
}

function isJsonContentType(req) {
  const ct = req.headers['content-type'];
  if (typeof ct !== 'string') return false;
  const type = ct.split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

// Every response is JSON, and never carries an Access-Control-Allow-Origin
// header: a web page must not be able to drive this API (see REST_API.md,
// "Why there is no read API").
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// Read the request body, counting ACTUAL bytes as they arrive (a lying
// Content-Length can't buy more than MAX). Resolves { text } | { tooBig:true }.
function readBody(req, res, maxBytes) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Trust the hint for a fast reject, but never trust it to be the truth.
      req.on('data', () => {});
      resolve({ tooBig: true });
      return;
    }
    let size = 0;
    let done = false;
    const chunks = [];
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (c) => {
      if (done) return; // already over the cap — drain the rest, keep nothing
      size += c.length;
      if (size > maxBytes) {
        chunks.length = 0;
        finish({ tooBig: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('aborted', () => finish({ aborted: true }));
    req.on('error', () => finish({ aborted: true }));
  });
}

// Defense in depth for the no-person-data rule: ingest.js only ever names
// fields and indexes, but if a reason ever quoted a value back, redact any
// person-authored string from this batch before it reaches the wire.
const SENSITIVE_PERSON_FIELDS = ['handle', 'displayName', 'bio', 'note', 'pronouns', 'avatarUrl'];
const SENSITIVE_OBS_FIELDS = ['text', 'place'];

function sensitiveStrings(batch) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.length >= 2) out.push(v);
  };
  if (batch && typeof batch === 'object') {
    if (Array.isArray(batch.persons))
      for (const p of batch.persons)
        if (p && typeof p === 'object') for (const f of SENSITIVE_PERSON_FIELDS) push(p[f]);
    if (Array.isArray(batch.observations))
      for (const o of batch.observations)
        if (o && typeof o === 'object') for (const f of SENSITIVE_OBS_FIELDS) push(o[f]);
  }
  return out;
}

function scrubReasons(rejected, batch) {
  const secrets = sensitiveStrings(batch);
  if (!secrets.length || !Array.isArray(rejected)) return rejected;
  return rejected.map((r) => {
    if (!r || typeof r.reason !== 'string') return r;
    let reason = r.reason;
    for (const s of secrets) {
      while (reason.includes(s)) reason = reason.replace(s, '[redacted]');
    }
    return reason === r.reason ? r : { ...r, reason };
  });
}

// The machine-readable contract, derived from ingest.js's own exported
// constants so this endpoint can never drift from the validator.
export function schemaDescriptor(maxBodyBytes = MAX_BODY_BYTES) {
  return {
    api: 'nx-orbit',
    apiVersion: 'v1',
    writeOnly: true,
    kinds: [...ingest.OBS_KINDS],
    statuses: [...ingest.STATUS_VALUES],
    personFields: [...ingest.PERSON_FIELDS],
    observationFields: [...ingest.OBS_FIELDS],
    requiredPersonFields: ['source', 'sourceId'],
    requiredObservationFields: ['source', 'sourceId', 'kind', 'ts'],
    sources: JSON.parse(JSON.stringify(ingest.PLUGIN_SOURCES)),
    self: { source: ingest.SELF_SOURCE, sourceId: ingest.SELF_ID },
    maxBodyBytes,
    batch: {
      plugin: 'string (a key of `sources`)',
      version: 'string (your plugin semver)',
      emittedAt: 'number (epoch ms)',
      persons: 'Person[] (upserts, may be empty)',
      observations: 'Observation[] (appended, deduped, may be empty)',
    },
    dedupKey: ['source', 'sourceId', 'kind', 'ts', 'coalesce(text, place, status)'],
    allOrNothing: true,
  };
}

// Operational telemetry about SOURCES — never about people. Reads the audit
// log's latest row per plugin through one fixed, parameterless statement.
const LAST_RUN_SQL =
  'SELECT plugin, version, received_at, n_persons, n_obs FROM ingest_log ' +
  'WHERE id IN (SELECT MAX(id) FROM ingest_log GROUP BY plugin) ORDER BY plugin';

function lastRuns() {
  try {
    return db
      .getDb()
      .prepare(LAST_RUN_SQL)
      .all()
      .map((r) => ({
        plugin: r.plugin,
        version: r.version,
        receivedAt: r.received_at,
        nPersons: r.n_persons,
        nObs: r.n_obs,
      }));
  } catch {
    return [];
  }
}

function schemaVersion() {
  try {
    const v = db.getMeta('schema_version');
    return v != null ? Number(v) : null;
  } catch {
    return null;
  }
}

// path → { methods:{ METHOD: handler }, auth:boolean }
// Handlers are (req, res, ctx) where ctx = { submit, token, maxBodyBytes, startedAt }.

// Start the server. Options: { port, token, submit, maxBodyBytes }.
//   submit defaults to ingest.submit (dependency-injectable for tests).
// Returns the node http.Server (call .close() to stop).
export function startIngestServer({
  port = 8477,
  token,
  submit = ingest.submit,
  maxBodyBytes = MAX_BODY_BYTES,
  onError, // optional: called if the listen fails (e.g. EADDRINUSE)
} = {}) {
  const authToken = token ?? getOrCreateToken();
  const startedAt = Date.now();

  // --- POST body → validated batch, shared by every ingest-ish endpoint ---
  // legacy: /ingest keeps its historical 422-on-bad-JSON shape so already
  // shipped emitters see no change; /api/v1/* uses the correct 400.
  async function handleBatch(req, res, { validateOnly, legacy }) {
    if (!isJsonContentType(req)) {
      return send(res, 415, { error: 'unsupported media type', detail: 'Content-Type must be application/json' });
    }
    const body = await readBody(req, res, maxBodyBytes);
    if (body.aborted) return;
    if (body.tooBig) {
      return send(res, 413, { error: 'payload too large', maxBodyBytes }, { Connection: 'close' });
    }
    let batch;
    try {
      batch = JSON.parse(body.text);
    } catch {
      if (legacy)
        return send(res, 422, {
          rejected: [{ part: 'batch', index: -1, field: null, reason: 'invalid JSON' }],
        });
      return send(res, 400, { error: 'invalid JSON' });
    }
    let result;
    try {
      result = submit(batch, { validateOnly });
    } catch {
      // Never surface an exception message: it can carry file paths.
      return send(res, 500, { error: 'ingest failed' });
    }
    if (validateOnly) {
      if (result.ok) return send(res, 200, { valid: true, would: result.would });
      return send(res, 422, { valid: false, rejected: scrubReasons(result.rejected, batch) });
    }
    if (result.ok) return send(res, 200, { accepted: result.accepted });
    return send(res, 422, { rejected: scrubReasons(result.rejected, batch) });
  }

  const routes = {
    // --- unversioned aliases (shipped plugins use these) ---
    '/health': {
      auth: false,
      methods: {
        GET: (req, res) => send(res, 200, { ok: true }),
      },
    },
    '/ingest': {
      auth: true,
      methods: {
        POST: (req, res) => handleBatch(req, res, { validateOnly: false, legacy: true }),
      },
    },

    // --- versioned surface ---
    '/api/v1/health': {
      auth: false,
      methods: {
        GET: (req, res) =>
          send(res, 200, {
            ok: true,
            version: APP_VERSION,
            schemaVersion: schemaVersion(),
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          }),
      },
    },
    '/api/v1/schema': {
      auth: true,
      methods: {
        GET: (req, res) => send(res, 200, schemaDescriptor(maxBodyBytes)),
      },
    },
    '/api/v1/sources': {
      auth: true,
      methods: {
        GET: (req, res) =>
          send(res, 200, {
            sources: JSON.parse(JSON.stringify(ingest.PLUGIN_SOURCES)),
            self: { source: ingest.SELF_SOURCE, sourceId: ingest.SELF_ID },
            lastRun: lastRuns(),
          }),
      },
    },
    '/api/v1/validate': {
      auth: true,
      methods: {
        POST: (req, res) => handleBatch(req, res, { validateOnly: true, legacy: false }),
      },
    },
    '/api/v1/ingest': {
      auth: true,
      methods: {
        POST: (req, res) => handleBatch(req, res, { validateOnly: false, legacy: false }),
      },
    },
  };

  const server = http.createServer((req, res) => {
    // 1. Defensive: never serve a non-loopback peer, even if bind were
    //    misconfigured. No response at all — just drop the socket.
    if (!isLoopback(req)) {
      res.socket?.destroy();
      return;
    }

    // 2. DNS-rebinding defense (see HOST_RE).
    if (!hostOk(req)) {
      return send(res, 403, { error: 'bad host header' });
    }

    let path;
    try {
      path = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      return send(res, 404, { error: 'not found' });
    }
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    const route = routes[path];
    if (!route) return send(res, 404, { error: 'not found' });

    const handler = route.methods[req.method];
    if (!handler) {
      // No CORS, ever: OPTIONS lands here too and gets a 405 rather than a
      // preflight approval, so a browser can never reach this API.
      return send(res, 405, { error: 'method not allowed' }, { Allow: Object.keys(route.methods).join(', ') });
    }

    if (route.auth && !bearerOk(req.headers['authorization'], authToken)) {
      return send(res, 401, { error: 'unauthorized' });
    }

    try {
      const r = handler(req, res);
      if (r && typeof r.catch === 'function') r.catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
      });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  });

  // A busy port must never take the app down. Orbit is fully usable without the
  // REST endpoint — the in-process readers still run and the dashboard still
  // works; only external emitters can't deliver. So surface it and carry on,
  // rather than letting an unhandled 'error' event reach the main process and
  // kill Electron with a raw exception dialog.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.warn(
        `[orbit] port ${port} is already in use — the REST ingest endpoint is ` +
          `disabled for this session. Another copy of NX Orbit is probably ` +
          `running, or something else holds the port. In-process sources still work.`
      );
    } else {
      console.warn('[orbit] ingest server error:', err && err.message);
    }
    server.lastError = err;
    if (typeof onError === 'function') onError(err);
  });

  server.listen(port, '127.0.0.1');
  return server;
}
