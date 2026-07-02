// Shared project-identity helpers (v4 contract §"Identity & registries").
//
//   project_id = `<dirname-slug>-<6-char sha256 of absolute path>`
//   slug: lowercase, non-alnum runs → "-", trimmed of leading/trailing "-".
//
// Stable, collision-safe, derivable by any script from the project root path
// alone. The same derivation is used by the plugin's SessionStart hook, so the
// dashboard's project_id must byte-match what lands in projects.json / the
// central journal/gate dirs. Keep this the single source of truth — both
// native-sessions.js and projects.js import from here.

import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { golemHome, journalsDir, gatesDir } from '../../lib/golem-home.js';

const HOME = os.homedir();

export const GOLEM_CONFIG_DIR = golemHome();
export const CENTRAL_JOURNALS_DIR = journalsDir();
export const CENTRAL_GATES_DIR = gatesDir();

/** Lowercase slug of a directory basename — non-alnum runs collapse to "-". */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive the stable project_id from an absolute project-root path.
 * @param {string} absRoot absolute path to the project root
 * @returns {string} `<slug>-<6hex>`
 */
export function projectIdFor(absRoot) {
  const abs = path.resolve(absRoot);
  const slug = slugify(path.basename(abs)) || 'project';
  const hex = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 6);
  return `${slug}-${hex}`;
}

/**
 * Walk up from a starting directory to the nearest project root, matching the
 * hook rule (v4 contract §"Project root resolution"): nearest dir containing a
 * `.git` entry or a `CLAUDE.md` file. Returns the start dir itself if nothing
 * is found before the filesystem root (best-effort, never throws).
 * @param {string} startDir
 * @returns {Promise<string>} absolute project-root path
 */
export async function resolveProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  // Guard against pathological loops; FS depth is bounded in practice.
  for (let i = 0; i < 64; i++) {
    // The home dir carries a global-rules CLAUDE.md — not a project root.
    // Stop the walk there so stray cwds don't all collapse into one
    // home-level project_id (mirrors the plugin hooks' guard).
    if (dir === HOME) break;
    let hit = false;
    try {
      await fs.access(path.join(dir, '.git'));
      hit = true;
    } catch {
      try {
        await fs.access(path.join(dir, 'CLAUDE.md'));
        hit = true;
      } catch {
        /* keep walking */
      }
    }
    if (hit) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached FS root
    dir = parent;
  }
  return path.resolve(startDir);
}

/** Central journal dir for a project_id (may or may not exist on disk). */
export function centralJournalDir(projectId) {
  return path.join(CENTRAL_JOURNALS_DIR, projectId);
}

/** Central gates dir for a project_id (may or may not exist on disk). */
export function centralGatesDir(projectId) {
  return path.join(CENTRAL_GATES_DIR, projectId);
}
