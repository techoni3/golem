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

import path from 'node:path';
import { golemHome, journalsDir, gatesDir } from '../../lib/golem-home.js';
export { projectIdFor, resolveProjectRoot, slugify } from '../../lib/project-id.js';

export const GOLEM_CONFIG_DIR = golemHome();
export const CENTRAL_JOURNALS_DIR = journalsDir();
export const CENTRAL_GATES_DIR = gatesDir();

/** Central journal dir for a project_id (may or may not exist on disk). */
export function centralJournalDir(projectId) {
  return path.join(CENTRAL_JOURNALS_DIR, projectId);
}

/** Central gates dir for a project_id (may or may not exist on disk). */
export function centralGatesDir(projectId) {
  return path.join(CENTRAL_GATES_DIR, projectId);
}
