// Discover workspaces under the substrate's two roots:
//   - $GOLEM_PROJECTS_ROOT (default golem-projects/) — bootstrapped projects.
//   - $GOLEM_IDEAS_ROOT    (default golem-ideas/)    — ideation scratchpads.
// Each entry carries a `kind` field ('project' | 'idea'). A project is a child
// directory containing either a journal/ dir or a CLAUDE.md; an idea is any
// non-dotfile directory under the ideas root.
// We exclude `archive/` and dotfile-prefixed dirs from both roots.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';
import { colorFor, glyphFor } from './util.js';
import {
  projectIdFor,
  centralJournalDir,
  centralGatesDir,
} from './project-id.js';
import { planPath } from './plan.js';

const REGISTRY_FILE = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'golem',
  'projects.json',
);

const EXCLUDED = new Set(['archive', 'node_modules']);

async function dirExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// v4: resolve journal/summary/hook paths. Prefer the central location
// (~/.config/golem/journals/<project_id>/) when that dir exists on disk;
// otherwise fall back to the legacy in-repo <path>/journal/. The central dir is
// keyed by the contract project_id derived from the absolute project root —
// NOT the dashboard's own registry id, which may differ for legacy entries.
async function resolveJournalPaths(projectPath, contractId) {
  const central = centralJournalDir(contractId);
  if (await dirExists(central)) {
    return {
      journalDir: central,
      hookFile: path.join(central, 'hook.jsonl'),
      summaryFile: path.join(central, 'summary.jsonl'),
      journalCentral: true,
    };
  }
  const legacy = path.join(projectPath, 'journal');
  return {
    journalDir: legacy,
    hookFile: path.join(legacy, 'hook.jsonl'),
    summaryFile: path.join(legacy, 'summary.jsonl'),
    journalCentral: false,
  };
}

// v4: gates dir — central (~/.config/golem/gates/<project_id>/) when present,
// else legacy in-repo docs/agent-notes/gates/.
async function resolveGatesDir(projectPath, contractId) {
  const central = centralGatesDir(contractId);
  if (await dirExists(central)) return { gatesDir: central, gatesCentral: true };
  return {
    gatesDir: path.join(projectPath, 'docs', 'agent-notes', 'gates'),
    gatesCentral: false,
  };
}

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

    const contractId = projectIdFor(workspaceDir);
    const jp = await resolveJournalPaths(workspaceDir, contractId);
    const gd = await resolveGatesDir(workspaceDir, contractId);

    out.push({
      id,
      project_id: contractId,
      kind,
      name: title,
      glyph: glyphFor(title),
      color: colorFor(id),
      description,
      path: workspaceDir,
      journalDir: jp.journalDir,
      hookFile: jp.hookFile,
      summaryFile: jp.summaryFile,
      journalCentral: jp.journalCentral,
      trackerDir: path.join(workspaceDir, 'tracker'),
      gatesDir: gd.gatesDir,
      gatesCentral: gd.gatesCentral,
      agentNotesDir: path.join(workspaceDir, 'docs', 'agent-notes'),
      hasJournal: hasJournal || jp.journalCentral,
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
  // The root is v3-wired (its own journal-event.sh owns it per the contract's
  // legacy-coexistence rule), so the central dir won't exist and we fall back
  // to the in-repo journal/ — which is exactly what we want here.
  const contractId = projectIdFor(root);
  const jp = await resolveJournalPaths(root, contractId);
  const gd = await resolveGatesDir(root, contractId);
  return {
    id,
    project_id: contractId,
    kind: 'root',
    name: title,
    glyph: glyphFor(title),
    color: colorFor(id),
    description,
    path: root,
    journalDir: jp.journalDir,
    hookFile: jp.hookFile,
    summaryFile: jp.summaryFile,
    journalCentral: jp.journalCentral,
    trackerDir: path.join(root, 'tracker'),
    gatesDir: gd.gatesDir,
    gatesCentral: gd.gatesCentral,
    agentNotesDir: path.join(root, 'docs', 'agent-notes'),
    hasJournal: hasJournal || jp.journalCentral,
  };
}

// Read ~/.config/golem/projects.json and surface any registered project whose
// `path` isn't already discovered by the auto-scan. This is the v3 mechanism
// for external projects (e.g. trialroomai outside golem/golem-projects/).
async function discoverFromRegistry(alreadyDiscoveredPaths) {
  let raw;
  try {
    raw = await fs.readFile(REGISTRY_FILE, 'utf8');
  } catch {
    return [];
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`[projects.js] failed to parse ${REGISTRY_FILE}:`, err.message);
    return [];
  }
  const out = [];
  for (const entry of json.projects ?? []) {
    if (!entry?.path || !entry?.id) continue;
    if (entry.kind === 'root') continue; // root is auto-discovered separately
    if (alreadyDiscoveredPaths.has(entry.path)) continue;

    // Only surface if the path actually exists.
    try {
      await fs.access(entry.path);
    } catch {
      continue;
    }

    const workspaceDir = entry.path;
    // v4: kind:"auto" entries are hook-registered (registered_by:"hook") and
    // carry the contract project_id as their `id`. They render like external
    // projects. Manual entries keep their registered kind. Either way the
    // central journal/gates dirs are keyed by the contract project_id derived
    // from the absolute path — derive it here so it matches the hook's writes
    // even if the registry `id` was hand-edited.
    const contractId = projectIdFor(workspaceDir);
    const jp = await resolveJournalPaths(workspaceDir, contractId);
    const gd = await resolveGatesDir(workspaceDir, contractId);

    // The registry `name` is user-supplied via `golem project register` and is
    // authoritative. Prefer it. An external project's own CLAUDE.md is NOT a
    // golem harness file — its H1 is often literally "CLAUDE.md" or unrelated
    // to the project — so it must not override the registered name. Fall back
    // to the CLAUDE.md H1 only when the registry has no name at all.
    const title = entry.name || (await readClaudeMdTitle(workspaceDir)) || entry.id;
    const description = (await readDescription(workspaceDir)) || '';
    // kind:"auto" (hook-registered) renders like external projects.
    const kind = entry.kind === 'auto' ? 'external' : (entry.kind ?? 'external');

    out.push({
      id: entry.id,
      project_id: contractId,
      registered_by: entry.registered_by ?? null,
      auto: entry.kind === 'auto',
      kind,
      name: title,
      glyph: glyphFor(title),
      color: colorFor(entry.id),
      description,
      path: workspaceDir,
      journalDir: jp.journalDir,
      hookFile: jp.hookFile,
      summaryFile: jp.summaryFile,
      journalCentral: jp.journalCentral,
      trackerDir: path.join(workspaceDir, 'tracker'),
      gatesDir: gd.gatesDir,
      gatesCentral: gd.gatesCentral,
      agentNotesDir: path.join(workspaceDir, 'docs', 'agent-notes'),
      hasJournal: jp.journalCentral || (await dirExists(jp.journalDir)),
    });
  }
  return out;
}

// Backwards-compatible name. Returns the CEO root workspace, projects (from
// auto-scan AND the v3 registry), and ideas with a `kind` field on each entry.
export async function discoverProjects() {
  const [rootWorkspace, projects, ideas] = await Promise.all([
    discoverRoot(),
    discoverFromRoot(CONFIG.projectsRoot, 'project', { requireSubstrate: true }),
    discoverFromRoot(CONFIG.ideasRoot, 'idea', { requireSubstrate: false }),
  ]);
  const alreadyDiscoveredPaths = new Set([
    ...(rootWorkspace ? [rootWorkspace.path] : []),
    ...projects.map((p) => p.path),
    ...ideas.map((p) => p.path),
  ]);
  const external = await discoverFromRegistry(alreadyDiscoveredPaths);

  const all = [];
  if (rootWorkspace) all.push(rootWorkspace);
  all.push(...projects, ...ideas, ...external);
  // Stable order: root first, then projects (alpha), then external (alpha), then ideas.
  const kindOrder = { root: 0, project: 1, external: 2, idea: 3 };
  all.sort((a, b) => {
    const oa = kindOrder[a.kind] ?? 9;
    const ob = kindOrder[b.kind] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.id.localeCompare(b.id);
  });
  // v4: stamp the PLAN.md path on every workspace so the watcher can observe
  // it and state.js can read progress. (The file may not exist — readPlan
  // handles that; we only need the path to watch + read.)
  for (const p of all) {
    p.planFile = planPath(p.path);
  }
  return all;
}
