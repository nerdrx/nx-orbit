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
import { register as registerIpc } from './ipc.js';
import { startIngestServer, getOrCreateToken } from './ingest-server.js';

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
          sourceState.set(mod.meta.name, { plugin: mod.meta.name, lastRun: null, lastOk: null, nPersons: 0 });
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
  const state = sourceState.get(name) ?? { plugin: name, lastRun: null, lastOk: null, nPersons: 0 };
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

function makeSourcesApi(plugins) {
  return {
    status: () => Array.from(sourceState.values()),
    runNow: async (name) => {
      const mod = name ? plugins.get(name) : null;
      if (name && !mod) return { ok: false, reason: `unknown plugin "${name}"` };
      if (mod) return runPlugin(mod);
      await runAll(plugins);
      return { ok: true };
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
