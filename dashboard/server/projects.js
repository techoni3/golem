// Discover workspaces under the substrate's two roots:
//   - $GOLEM_PROJECTS_ROOT (default golem-projects/) — bootstrapped projects.
//   - $GOLEM_IDEAS_ROOT    (default golem-ideas/)    — ideation scratchpads.
// Each entry carries a `kind` field ('project' | 'idea'). A project is a child
// directory containing either a journal/ dir or a CLAUDE.md; an idea is any
// non-dotfile directory under the ideas root.
// We exclude `archive/` and dotfile-prefixed dirs from both roots.

import path from 'node:path';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';
import { colorFor, glyphFor } from './util.js';

const EXCLUDED = new Set(['archive', 'node_modules']);

async function readClaudeMdTitle(projectDir) {
  try {
    const md = await fs.readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const m = md.match(/^#\s+(.+?)\s*$/m);
    if (m) {
      const t = m[1].replace(/[`*_]/g, '').trim();
      if (t && !t.includes('{{')) return t;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function readDescription(projectDir) {
  // Prefer the first non-comment paragraph after "## What this project is".
  try {
    const md = await fs.readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const startIdx = md.search(/##\s+What this project is/m);
    if (startIdx !== -1) {
      const after = md.slice(startIdx).split(/\n##\s+/)[0]; // up to next heading
      // Strip HTML comments, then collect non-blank lines.
      const cleaned = after.replace(/<!--[\s\S]*?-->/g, '');
      const lines = cleaned.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
      const para = lines.join(' ');
      if (para && !para.includes('{{') && para.length > 8) return para.slice(0, 280);
    }
    // Fallback: README.md first sentence.
    try {
      const readme = await fs.readFile(path.join(projectDir, 'README.md'), 'utf8');
      const lines = readme.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      if (lines[0]) return lines[0].slice(0, 280);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function discoverFromRoot(root, kind, { requireSubstrate }) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || EXCLUDED.has(e.name)) continue;
    const workspaceDir = path.join(root, e.name);
    const journalDir = path.join(workspaceDir, 'journal');
    const claudeMd = path.join(workspaceDir, 'CLAUDE.md');
    let hasJournal = false;
    let hasClaudeMd = false;
    try { await fs.access(journalDir); hasJournal = true; } catch { /* ignore */ }
    try { await fs.access(claudeMd); hasClaudeMd = true; } catch { /* ignore */ }
    if (requireSubstrate && !hasJournal && !hasClaudeMd) continue;

    const id = `${kind === 'idea' ? 'idea:' : ''}${e.name}`;
    const title = (await readClaudeMdTitle(workspaceDir)) || e.name;
    const description = (await readDescription(workspaceDir)) || '';

    out.push({
      id,
      kind,
      name: title,
      glyph: glyphFor(title),
      color: colorFor(id),
      description,
      path: workspaceDir,
      journalDir,
      hookFile: path.join(journalDir, 'hook.jsonl'),
      summaryFile: path.join(journalDir, 'summary.jsonl'),
      trackerDir: path.join(workspaceDir, 'tracker'),
      gatesDir: path.join(workspaceDir, 'docs', 'agent-notes', 'gates'),
      agentNotesDir: path.join(workspaceDir, 'docs', 'agent-notes'),
      hasJournal,
    });
  }
  return out;
}

// Discover the CEO workspace ($GOLEM_ROOT itself, not its children). The CEO
// session anchors cwd here, so its tool calls and sub-agent spawns journal
// into $GOLEM_ROOT/journal/. We surface it as a special kind='root' workspace
// alongside the per-project ones.
async function discoverRoot() {
  const root = CONFIG.golemRoot;
  const journalDir = path.join(root, 'journal');
  const claudeMd = path.join(root, 'CLAUDE.md');
  const hookScript = path.join(root, '.claude', 'hooks', 'journal-event.sh');
  let hasJournal = false;
  let hasClaudeMd = false;
  let hasHook = false;
  try { await fs.access(journalDir); hasJournal = true; } catch { /* ignore */ }
  try { await fs.access(claudeMd); hasClaudeMd = true; } catch { /* ignore */ }
  try { await fs.access(hookScript); hasHook = true; } catch { /* ignore */ }
  // Only surface if at least the hook script is in place — otherwise it's an
  // un-wired root and there will be no events to show.
  if (!hasHook) return null;
  const id = 'golem-root';
  const title = (await readClaudeMdTitle(root)) || 'Golem Root';
  const description = (await readDescription(root)) || 'CEO orchestration workspace — journals CEO + sub-agent activity.';
  return {
    id,
    kind: 'root',
    name: title,
    glyph: glyphFor(title),
    color: colorFor(id),
    description,
    path: root,
    journalDir,
    hookFile: path.join(journalDir, 'hook.jsonl'),
    summaryFile: path.join(journalDir, 'summary.jsonl'),
    trackerDir: path.join(root, 'tracker'),
    gatesDir: path.join(root, 'docs', 'agent-notes', 'gates'),
    agentNotesDir: path.join(root, 'docs', 'agent-notes'),
    hasJournal,
  };
}

// Backwards-compatible name. Returns the CEO root workspace, projects, and
// ideas with a `kind` field on each entry. Callers that need only one kind
// filter on it.
export async function discoverProjects() {
  const [rootWorkspace, projects, ideas] = await Promise.all([
    discoverRoot(),
    discoverFromRoot(CONFIG.projectsRoot, 'project', { requireSubstrate: true }),
    discoverFromRoot(CONFIG.ideasRoot, 'idea', { requireSubstrate: false }),
  ]);
  const all = [];
  if (rootWorkspace) all.push(rootWorkspace);
  all.push(...projects, ...ideas);
  // Stable order: root first, then projects (alpha), then ideas (alpha).
  const kindOrder = { root: 0, project: 1, idea: 2 };
  all.sort((a, b) => {
    const oa = kindOrder[a.kind] ?? 9;
    const ob = kindOrder[b.kind] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.id.localeCompare(b.id);
  });
  return all;
}
