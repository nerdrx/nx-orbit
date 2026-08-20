// src/main/credentials.js — the ONLY module that reads/writes the source
// credentials file (~/.config/nx-orbit/credentials.json).
//
// SPEC §0.2 amendment: credentials the operator enters (a Steam API key, a
// token) live in a 0600 file in ~/.config/nx-orbit/, NEVER in orbit.sqlite3 (so
// copying the database can never leak a secret) and are NEVER sent to the
// renderer in full. This module is the single choke point that enforces those
// two rules: everything is stored here, and `redact()` is the only shape the
// IPC/renderer layer is ever handed.
//
// Pure Node (no electron) so it stays unit-testable headless. The directory is
// resolved by paths.js — the ONE config-dir helper (SPEC §4) — which honours
// $NX_ORBIT_CONFIG_DIR at call time; this module used to hand-roll that rule and
// was the only one that had it, which is how a dev build ended up writing into
// the installed build's database. `configDir` is re-exported so existing callers
// keep working, but it is now the helper's client, not a second implementation.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import * as paths from './paths.js';

const FILE_MODE = 0o600; // rw for the owner only — never group/other readable

export const configDir = paths.configDir;

const credentialsPath = paths.credentialsPath;

// Read the whole store, or {} if it does not exist / is unreadable. A corrupt
// file is treated as empty rather than throwing — a bad secret store must never
// take the whole app down; the operator simply reconnects.
function readAll() {
  const p = credentialsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Write the whole store, creating the dir (0700) and file (0600) if needed. The
// mode is (re)asserted on every write so a pre-existing loose-permission file is
// tightened rather than trusted.
function writeAll(store) {
  paths.ensureConfigDir();
  const p = credentialsPath();
  writeFileSync(p, JSON.stringify(store, null, 2), { mode: FILE_MODE });
  try {
    chmodSync(p, FILE_MODE); // assert 0600 even if the file already existed
  } catch {
    /* best effort — some filesystems (e.g. Windows) ignore POSIX modes */
  }
}

// Get one source's stored config object, or null if the source is unconfigured.
// Returns the RAW config (secrets included) — only main-process callers may see
// this; anything crossing IPC must go through redact().
export function getSourceConfig(plugin) {
  const cfg = readAll()[plugin];
  return cfg && typeof cfg === 'object' ? cfg : null;
}

// Store (replace) one source's config. Other sources' configs are untouched.
export function setSourceConfig(plugin, cfg) {
  const store = readAll();
  store[plugin] = cfg;
  writeAll(store);
  return true;
}

// Forget one source's credentials. Leaves already-ingested people alone (that is
// the caller's concern) — this only clears the secret. No-op if absent.
export function clearSourceConfig(plugin) {
  const store = readAll();
  if (!(plugin in store)) return false;
  delete store[plugin];
  writeAll(store);
  return true;
}

// A safe-to-show projection of a source's config for IPC/renderer. NEVER returns
// the full API key — only whether one is present and its last four characters,
// so the UI can reassure ("key ending …AB12") without ever echoing the secret.
export function redact(plugin, cfg) {
  const c = cfg ?? getSourceConfig(plugin);
  if (!c) return null;
  const apiKey = typeof c.apiKey === 'string' ? c.apiKey : '';
  return {
    steamId: c.steamId ?? null,
    account: c.account ?? null,
    apiKeyPresent: apiKey.length > 0,
    apiKeyLast4: apiKey ? '…' + apiKey.slice(-4) : null,
  };
}

export default { configDir, getSourceConfig, setSourceConfig, clearSourceConfig, redact };
