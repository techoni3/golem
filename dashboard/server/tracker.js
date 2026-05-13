// Read tracker/<state>/*.md tickets for a project. Each file's frontmatter
// defines: id, title, state, plus optional category, labels, dependencies,
// effort, assignee. We map that to the dashboard's ticket shape:
//
//   { id, project, title, column, assignee, priority }
//
// `column` ∈ {triage, open, in-progress, review, blocked, done}
// `priority` is derived from labels (P0/P1/P2/P3) when not explicit, then
// from `effort` (large→P0, medium→P1, small→P2) as a fallback.

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

const COLUMNS = ['triage', 'open', 'in-progress', 'review', 'blocked', 'done'];

function priorityFromMeta(meta) {
  if (!meta) return null;
  if (meta.priority) {
    const p = String(meta.priority).toUpperCase();
    if (/^P\d$/.test(p)) return p;
  }
  const labels = Array.isArray(meta.labels) ? meta.labels.map(String) : [];
  for (const l of labels) {
    const m = l.toUpperCase().match(/^P(\d)$/);
    if (m) return `P${m[1]}`;
    if (l.toLowerCase() === 'blocking' || l.toLowerCase() === 'critical') return 'P0';
  }
  if (meta.effort) {
    const e = String(meta.effort).toLowerCase();
    if (e === 'large') return 'P1';
    if (e === 'medium') return 'P2';
    if (e === 'small') return 'P3';
  }
  return null;
}

async function readTicketFile(filePath, projectId, column) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const fm = parsed.data ?? {};
  const id = fm.id ?? path.basename(filePath, '.md').toUpperCase();
  const title = fm.title ?? id;
  return {
    id: String(id),
    project: projectId,
    title: String(title),
    column,
    assignee: fm.assignee ?? null,
    priority: priorityFromMeta(fm),
    state: fm.state ?? column,
    category: fm.category ?? null,
    labels: Array.isArray(fm.labels) ? fm.labels.map(String) : [],
    file: filePath,
  };
}

export async function readTickets(project) {
  const out = [];
  for (const col of COLUMNS) {
    const dir = path.join(project.trackerDir, col);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      if (name.toLowerCase() === 'readme.md') continue;
      const t = await readTicketFile(path.join(dir, name), project.id, col);
      if (t) out.push(t);
    }
  }
  // Stable order: by id, then column.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function ticketProgress(tickets) {
  if (!tickets.length) return 0;
  const done = tickets.filter((t) => t.column === 'done').length;
  return done / tickets.length;
}

export const TRACKER_COLUMNS = COLUMNS;
