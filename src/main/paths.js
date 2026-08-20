// src/main/paths.js — the ONE resolver for Orbit's config directory (SPEC §4,
// "Config-dir isolation"). Pure Node (node:fs/os/path), no electron, so every
// module — db, credentials, the ingest server — can share it headless.
//
// WHY THIS EXISTS. Everything Orbit persists (orbit.sqlite3, ingest.token,
// credentials.json) lives in one directory, and three modules used to spell that
// directory out for themselves. They agreed on the default and disagreed on the
// override: credentials.js honoured $NX_ORBIT_CONFIG_DIR, db.js and
// ingest-server.js did not. So a development build and the installed build shared
// one database, and a plugin's *test fixtures* — invented Steam and Discord
// accounts — landed in a real person's friend roster. One resolver, used by
// everyone, is the fix. Adding a new file under the config dir means adding a
// function here, never a fresh join(homedir(), ...) somewhere else.
//
// The environment is read AT CALL TIME, never captured at module load: tests set
// $NX_ORBIT_CONFIG_DIR per case (and the app may be launched with it), and a
// value frozen at import would silently point the second caller at the first
// caller's directory — the very bug this module exists to prevent.

import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The directory itself is owner-only: it holds a bearer token and API keys.
export const DIR_MODE = 0o700;

/** The config directory: $NX_ORBIT_CONFIG_DIR if set, else ~/.config/nx-orbit. */
export function configDir() {
  const override = process.env.NX_ORBIT_CONFIG_DIR;
  // A set-but-empty variable is an accident (`NX_ORBIT_CONFIG_DIR=` in a script),
  // and honouring it would resolve every path relative to the cwd. Fall back.
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(homedir(), '.config', 'nx-orbit');
}

/** The SQLite datastore (SPEC §4). */
export function dbPath() {
  return join(configDir(), 'orbit.sqlite3');
}

/** The loopback ingest bearer token (SPEC §1), 0600. */
export function tokenPath() {
  return join(configDir(), 'ingest.token');
}

/** The source credentials store (SPEC §0.2), 0600. */
export function credentialsPath() {
  return join(configDir(), 'credentials.json');
}

/**
 * Create the config dir if missing and assert 0700 on it. Returns the path.
 * The chmod is best-effort: filesystems without POSIX modes (Windows, some
 * network mounts) simply ignore it, and that must not be fatal.
 */
export function ensureConfigDir() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* best effort */
  }
  return dir;
}

export default { configDir, dbPath, tokenPath, credentialsPath, ensureConfigDir, DIR_MODE };
