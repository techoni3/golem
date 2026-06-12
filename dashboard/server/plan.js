// PLAN.md progress parsing (v4 contract §PLAN.md + §Dashboard.3).
//
// PLAN.md lives at <project root>/PLAN.md. Format per contract: an H1 title,
// an optional context paragraph, then a single FLAT GitHub-checkbox list —
// one item per line, `- [ ]` (open) / `- [x]` (done). No nesting, no tables.
// Progress = checked / total.
//
// We parse leniently: any line matching the checkbox pattern (with optional
// leading indentation and `-`/`*`/`+` bullet) counts as an item, so a model
// that indents slightly or uses `*` doesn't break the bar. Everything else is
// ignored. Returns null when no PLAN.md exists (project simply has no plan).

import fs from 'node:fs/promises';
import path from 'node:path';

// `- [ ] text` / `- [x] text` / `* [X] text` — capture the checked flag + text.
const ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)?\s*$/;
const H1_RE = /^#\s+(.+?)\s*$/;

/**
 * Parse PLAN.md contents into { title, total, done, items }.
 * @param {string} md raw markdown
 * @returns {{title: string|null, total: number, done: number, items: Array<{text: string, done: boolean}>}}
 */
export function parsePlan(md) {
  let title = null;
  const items = [];
  for (const line of String(md).split('\n')) {
    if (title == null) {
      const h = line.match(H1_RE);
      if (h) {
        title = h[1].replace(/[`*_]/g, '').trim() || null;
        continue;
      }
    }
    const m = line.match(ITEM_RE);
    if (m) {
      const checked = m[1] === 'x' || m[1] === 'X';
      const text = (m[2] ?? '').trim();
      items.push({ text, done: checked });
    }
  }
  const done = items.filter((i) => i.done).length;
  return { title, total: items.length, done, items };
}

/** Absolute path to a project's PLAN.md given its root path. */
export function planPath(projectPath) {
  return path.join(projectPath, 'PLAN.md');
}

/**
 * Read + parse a project's PLAN.md. Returns null when the file does not exist
 * (or can't be read). Never throws.
 * @param {string} projectPath project root
 * @returns {Promise<{title, total, done, items}|null>}
 */
export async function readPlan(projectPath) {
  if (!projectPath) return null;
  let md;
  try {
    md = await fs.readFile(planPath(projectPath), 'utf8');
  } catch {
    return null; // ENOENT or unreadable → no plan
  }
  return parsePlan(md);
}
