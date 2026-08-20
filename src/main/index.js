// src/main/index.js — Electron bootstrap. Owns the app lifecycle, the single
// BrowserWindow, the in-process reader scheduler, and the loopback ingest
// server. This is the ONLY [core] module that imports electron; db/ingest/
// digest/ingest-server stay pure Node so they remain unit-testable headless.

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import * as db from './db.js';
import * as ingest from './ingest.js';
import * as credentials from './credentials.js';
import { register as registerIpc } from './ipc.js';
import { startIngestServer, getOrCreateToken } from './ingest-server.js';
import { mergeSourceStatus } from './sources-status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, 'plugins');
const SCHEDULE_MINUTES = 15;

let mainWindow = null;
let ingestServer = null;
let scheduleTimer = null;

// ---------------------------------------------------------------------------
// In-process source registry (SPEC §6 sources.status / sources.runNow)
// ---------------------------------------------------------------------------

const sourceState = new Map(); // plugin name → { plugin, lastRun, lastOk, nPersons }

function pluginCtx() {
  return {
    log: (...a) => console.log('[plugin]', ...a),
    paths: { config: join(app.getPath('home'), '.config') },
    settings: db.getSettings(),
  };
}

// Discover in-process readers in src/main/plugins/*.js. Each may still be under
// construction by another agent, so every import/shape check is guarded.
async function loadPlugins() {
  const plugins = new Map(); // name → module
  let files = [];
  try {
    files = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.js'));
  } catch {
    return plugins; // no plugins dir yet — app still boots
  }
  for (const f of files) {
    try {
      const mod = await import(join(PLUGINS_DIR, f));
      if (mod && mod.meta && typeof mod.collect === 'function') {
        plugins.set(mod.meta.name, mod);
        if (!sourceState.has(mod.meta.name))
          sourceState.set(mod.meta.name, {
            plugin: mod.meta.name,
            // The Person.source this reader writes — status() uses it to tell
            // which registry entries a reader already covers (so the Steam
            // reader's card and a "steam-orbit" emitter row are not both shown).
            source: mod.meta.source ?? null,
            lastRun: null,
            lastOk: null,
            nPersons: 0,
          });
      } else {
        console.warn('[plugins] skipping incomplete plugin', f);
      }
    } catch (e) {
      console.warn('[plugins] failed to load', f, e.message);
    }
  }
  return plugins;
}

async function runPlugin(mod) {
  const name = mod.meta.name;
  const state = sourceState.get(name) ?? {
    plugin: name,
    source: mod.meta.source ?? null,
    lastRun: null,
    lastOk: null,
    nPersons: 0,
  };
  state.lastRun = Date.now();
  try {
    const batch = await mod.collect(pluginCtx());
    const result = ingest.submit(batch);
    state.lastOk = result.ok;
    if (result.ok) {
      state.nPersons = db.listPersons({ source: mod.meta.source }).length;
    } else {
      console.warn('[plugins]', name, 'batch rejected', result.rejected?.slice(0, 5));
    }
    sourceState.set(name, state);
    return result;
  } catch (e) {
    state.lastOk = false;
    sourceState.set(name, state);
    console.warn('[plugins]', name, 'collect threw', e.message);
    return { ok: false, rejected: [{ part: 'batch', index: -1, field: null, reason: e.message }] };
  }
}

async function runAll(plugins) {
  for (const mod of plugins.values()) await runPlugin(mod);
}

// A source is "configurable" (has a Connect flow in the Sources UI) iff its
// plugin module exports a validate() — steam does, vrcx does not (SPEC §6).
function isConfigurable(mod) {
  return !!(mod && typeof mod.validate === 'function');
}

function makeSourcesApi(plugins) {
  return {
    // Two populations, one list (SPEC §1 has two ingest paths; the Sources view
    // used to show only the first):
    //   kind:"reader"  — in-process readers, from `sourceState` as before, still
    //                    reporting { configurable, connected, account } with the
    //                    secret REDACTED via credentials.js.
    //   kind:"emitter" — external plugins that POST to the loopback API. They
    //                    have no in-process state at all, so their evidence is
    //                    the `ingest_log` audit table; the ones that have never
    //                    delivered still get a row, marked "waiting", because a
    //                    silent absence is exactly what the user is debugging.
    // Additive: every field the old shape carried is still there.
    status: () => {
      const readers = Array.from(sourceState.values()).map((s) => {
        const mod = plugins.get(s.plugin);
        const red = credentials.redact(s.plugin);
        return {
          ...s,
          configurable: isConfigurable(mod),
          connected: !!red,
          account: red?.account ?? null,
        };
      });
      let deliveries = [];
      let personCounts = {};
      try {
        deliveries = db.ingestLogSummary();
        personCounts = db.personCountsBySource();
      } catch (e) {
        // The Sources view must render even if the audit query fails; readers
        // still report, emitters simply read as never-delivered.
        console.warn('[orbit] ingest_log summary failed', e.message);
      }
      return mergeSourceStatus({
        readers,
        deliveries,
        personCounts,
        pluginSources: ingest.PLUGIN_SOURCES,
      });
    },
    // The ingest token, on explicit request only (SPEC §6 sources.token). This
    // is the operator's own bearer token for their own loopback server, and an
    // external emitter is useless without it — the #1 reason a freshly
    // installed Vencord bridge silently does nothing is that it was never
    // pasted in. It never leaves this machine, and the renderer only asks when
    // the operator clicks Reveal/Copy.
    token: async () => {
      try {
        return { token: getOrCreateToken() };
      } catch (e) {
        return { token: null, reason: e?.message || 'could not read the ingest token' };
      }
    },
    runNow: async (name) => {
      const mod = name ? plugins.get(name) : null;
      if (name && !mod) return { ok: false, reason: `unknown plugin "${name}"` };
      if (mod) return runPlugin(mod);
      await runAll(plugins);
      return { ok: true };
    },
    // Dry-run: validate credentials WITHOUT saving (SPEC §6 sources.test).
    test: async (name, cfg) => {
      const mod = plugins.get(name);
      if (!isConfigurable(mod)) return { ok: false, reason: `"${name}" is not configurable` };
      try {
        return await mod.validate(cfg ?? {});
      } catch (e) {
        return { ok: false, reason: e?.message || 'validation failed' };
      }
    },
    // Validate, and on success store the config (0600 file, never the DB) and kick
    // an immediate run so the roster fills in without waiting for the scheduler.
    configure: async (name, cfg) => {
      const mod = plugins.get(name);
      if (!isConfigurable(mod)) return { ok: false, reason: `"${name}" is not configurable` };
      let res;
      try {
        res = await mod.validate(cfg ?? {});
      } catch (e) {
        return { ok: false, reason: e?.message || 'validation failed' };
      }
      if (!res.ok) return res;
      // Store the raw key + the RESOLVED SteamID64 + the persona name. The key is
      // a secret (0600 file); account is a safe display string used by status().
      credentials.setSourceConfig(name, {
        apiKey: String(cfg?.apiKey ?? '').trim(),
        steamId: res.steamId,
        account: res.account,
      });
      runPlugin(mod).catch((e) => console.warn('[plugins]', name, 'post-configure run failed', e.message));
      return { ok: true, connected: true, account: res.account, friendCount: res.friendCount };
    },
    // Forget a source's credentials. Already-ingested people are left alone (use
    // people.forget to delete a person's data) — this only drops the secret.
    disconnect: async (name) => {
      credentials.clearSourceConfig(name);
      return {
        ok: true,
        connected: false,
        note: 'Steam credentials removed. Already-synced people are kept on this machine — delete a person with Forget on their card.',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    backgroundColor: '#0a0a12',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function bootstrap() {
  db.open();

  // Prune raw events on the rolling retention window (SPEC §0.5) on startup.
  const { retentionDays, ingestPort } = db.getSettings();
  db.pruneOlderThan(Date.now() - retentionDays * 86400000);

  const plugins = await loadPlugins();
  const sources = makeSourcesApi(plugins);

  registerIpc({ sources });

  const token = getOrCreateToken();
  ingestServer = startIngestServer({
    port: ingestPort,
    token,
    // A busy port disables external emitters but leaves the rest of the app
    // working, so tell the renderer instead of dying (see ingest-server.js).
    onError: (err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orbit:sources.serverError', {
          code: err?.code ?? 'UNKNOWN',
          port: ingestPort,
        });
      }
    },
  });
  console.log(`[orbit] ingest endpoint on 127.0.0.1:${ingestPort}`);

  // First scan, then run readers on a timer.
  runAll(plugins).catch((e) => console.warn('[orbit] initial scan failed', e.message));
  scheduleTimer = setInterval(() => {
    runAll(plugins).catch((e) => console.warn('[orbit] scheduled scan failed', e.message));
  }, SCHEDULE_MINUTES * 60 * 1000);
  scheduleTimer.unref?.();

  createWindow();
}

// One Orbit per machine. Without this a second launch races the first for the
// ingest port and for SQLite, and the loser died with a raw JavaScript-error
// dialog. Now the second copy hands off and exits; the running one comes
// forward, which is what the person double-clicking the icon actually wanted.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(bootstrap);
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (ingestServer) ingestServer.close();
  db.close();
});
