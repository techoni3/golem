import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

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
 * hook rule: nearest dir containing a `.git` entry or a `CLAUDE.md` file.
 * Returns the start dir itself if nothing is found before the filesystem root.
 * @param {string} startDir
 * @returns {Promise<string>} absolute project-root path
 */
export async function resolveProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 64; i++) {
    if (dir === HOME) break;
    let hit = false;
    try {
      await fs.access(path.join(dir, '.git'));
      // Worktree check: if .git is a file, remap to the main repo root.
      // A git worktree's .git file contains "gitdir: <main>/.git/worktrees/<name>".
      // This must win over the CLAUDE.md stop (a worktree checks out CLAUDE.md too).
      const gitStat = await fs.stat(path.join(dir, '.git'));
      if (gitStat.isFile()) {
        const content = await fs.readFile(path.join(dir, '.git'), 'utf8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitdirPath = match[1].trim();
          const mainRoot = gitdirPath.replace(/\/\.git\/worktrees\/[^/]+$/, '');
          try {
            await fs.access(mainRoot);
            return mainRoot;
          } catch {
            // main root unreachable — fall through to return dir
          }
        }
      }
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
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}
