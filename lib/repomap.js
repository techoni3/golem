import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { golemHome, projectsJsonPath } from './golem-home.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { runExternalTool } from './ext-tools.js';

const GENERATOR = 'golem-aider-repomap';
// budget == the effective token size of the map. The wrapper runs aider with
// map_mul_no_files=1 and an effectively-unbounded context window (see
// AIDER_WRAPPER), so aider's binary search fills the map to ~this many tokens.
// 3000 was far too thin for a real repo (~90 files, symbol stubs); 8000 gives a
// usable whole-repo orientation (~200 files with real symbols). aider's own
// default multiplies a cold (no-chat-files) map by 8 for exactly this reason —
// we make that explicit and predictable via the budget knob instead.
const DEFAULT_BUDGET = 8000;
const DEFAULT_FOCUSED_BUDGET = 1000;
// Effectively unbounded: keep aider's `max_context_window - padding` clamp from
// silently capping the map below the requested budget. The budget is the knob.
const CONTEXT_WINDOW = 1_000_000;
const KEEP_MAPS = 3;
const ORIENTATION = 'Orientation only; verify from source before editing. This map is not a boundary.';
const EXCLUDED_SOURCE_PREFIXES = ['plugin/'];

function runGit(args, cwd, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFail && res.status !== 0) throw new Error((res.stderr || res.stdout || `git ${args.join(' ')} failed`).trim());
  return res;
}

function shortCommit(commit) {
  return String(commit || '').slice(0, 7);
}

export function repoMapDir(projectId) {
  return path.join(golemHome(), 'repomap', projectId);
}

export function latestRepoMap(projectRoot) {
  const projectId = projectIdFor(projectRoot);
  const dir = repoMapDir(projectId);
  if (!existsSync(dir)) return null;
  const maps = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const text = readFileSync(file, 'utf8');
        const commit = /^commit: ([^\n]+)/m.exec(text)?.[1] || name.replace(/\.md$/, '');
        const dirty = /^dirty: true$/m.test(text);
        return { file, commit, dirty, mtimeMs: statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return maps[0] ?? null;
}

function currentCommit(root) {
  return runGit(['rev-parse', 'HEAD'], root).stdout.trim();
}

function isDirty(root) {
  const res = runGit(['status', '--porcelain'], root, { allowFail: true });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function gitTrackedRegularFiles(root) {
  return runGit(['ls-files'], root).stdout.split('\n').filter(Boolean).filter((rel) => {
    if (EXCLUDED_SOURCE_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  }).sort();
}

function readFirstParagraph(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split(/\n\s*\n/).map((p) => p.replace(/^# .*\n?/, '').trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function manifestCommands(root) {
  const out = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    for (const name of ['test', 'check', 'lint', 'build']) {
      if (scripts[name]) out.push(`npm run ${name}`);
    }
  } catch {}
  try {
    const py = readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
    if (/pytest|\[tool\.pytest/.test(py)) out.push('pytest');
  } catch {}
  return [...new Set(out)].slice(0, 6);
}

function projectHeader({ projectId, root, commit, dirty, budget, focus, generatedAt, version, warnings = [] }) {
  const readme = readFirstParagraph(path.join(root, 'README.md'));
  const commands = manifestCommands(root);
  const lines = [
    '# Repo map',
    '',
    `project: ${projectId}`,
    `root: ${root}`,
    `commit: ${commit}`,
    `generated-at: ${generatedAt}`,
    `dirty: ${dirty ? 'true' : 'false'}`,
    `generator: ${GENERATOR}`,
    `budget: ${budget}`,
    `version: ${version}`,
    '',
    ORIENTATION,
  ];
  if (readme) lines.push('', `summary: ${readme.replace(/\s+/g, ' ').slice(0, 500)}`);
  if (commands.length) lines.push('', 'run/test commands:', ...commands.map((c) => `- ${c}`));
  if (focus?.files?.length || focus?.symbols?.length) {
    lines.push('', 'focus hints:', ...[...(focus.files || []), ...(focus.symbols || []).map((s) => `symbol:${s}`)].map((f) => `- ${f}`));
  }
  if (warnings.length) lines.push('', 'warnings:', ...warnings.map((w) => `- ${w}`));
  lines.push('', '## Ranked map', '');
  return lines.join('\n');
}

const AIDER_WRAPPER = String.raw`
import os, sys, json
from aider.repomap import RepoMap
from aider.io import InputOutput
class TokenModel:
    def token_count(self, text):
        return max(1, len(text) // 4)
payload=json.loads(sys.stdin.read())
root=payload["root"]
files=payload.get("files", [])
focus=payload.get("focus", {}) or {}
chat=set(focus.get("files") or [])
idents=set(focus.get("symbols") or [])
abs_files=[os.path.join(root, f) for f in files]
abs_chat=[os.path.join(root, f) for f in chat if f in files]
other=[f for f in abs_files if f not in abs_chat]
# Relocate aider's tags cache OUT of the target repo. By default aider writes a
# multi-MB .aider.tags.cache.vN/ dir into root, polluting the user's working
# tree with untracked debris. Setting TAGS_CACHE_DIR to an ABSOLUTE path makes
# aider's Path(root)/TAGS_CACHE_DIR resolve to that path (an absolute join
# discards root) -- zero repo footprint, cache reuse preserved under ~/.golem.
cache_dir=payload.get("cache_dir")
if cache_dir:
    RepoMap.TAGS_CACHE_DIR = cache_dir
io=InputOutput(pretty=False, yes=True, fancy_input=False, root=root)
rm=RepoMap(map_tokens=int(payload.get("budget") or 8000), root=root, main_model=TokenModel(), io=io, verbose=False, max_context_window=int(payload.get("max_context_window") or 1000000), map_mul_no_files=1)
out=rm.get_repo_map(chat_files=abs_chat, other_files=other, mentioned_fnames=set(chat), mentioned_idents=idents, force_refresh=bool(payload.get("force_refresh")))
print(out or "")
`;

function stripToolNoise(stdout) {
  return String(stdout || '').split('\n')
    .filter((line) => !/^Initial repo scan can be slow/.test(line))
    .join('\n')
    .trim();
}

function unsafeLine(line) {
  return /(^|[\s/])\.[^\s/]+\//.test(line) || /(^|\/)node_modules\//.test(line) || /__pycache__\//.test(line);
}

function applySafetyNet(mapText) {
  const removed = [];
  const kept = [];
  for (const line of String(mapText || '').split('\n')) {
    if (unsafeLine(line)) removed.push(line);
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), warnings: removed.length ? [`removed ${removed.length} unsafe ignored/dot-dir output line(s)`] : [] };
}

function pruneMaps(dir, keep = KEEP_MAPS) {
  if (!existsSync(dir)) return;
  const maps = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, file: path.join(dir, name), mtimeMs: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of maps.slice(keep)) unlinkSync(old.file);
}

function topRankedFiles(content, limit = 15) {
  return [...String(content || '').matchAll(/^([^\n:][^\n]*):\n(?:⋮\n)?│/gm)].map((m) => m[1]).slice(0, limit);
}

export async function generateMap(startPath, { force = false, version = 'unknown', budget = DEFAULT_BUDGET, focus = null, cache = true } = {}) {
  const root = await resolveProjectRoot(startPath || process.cwd());
  const projectId = projectIdFor(root);
  const commit = currentCommit(root);
  const dirty = isDirty(root);
  const generatedAt = new Date().toISOString();
  const files = gitTrackedRegularFiles(root);
  const focused = !!(focus && ((focus.files || []).length || (focus.symbols || []).length));
  const effectiveBudget = Number(budget || (focused ? DEFAULT_FOCUSED_BUDGET : DEFAULT_BUDGET));
  const dir = repoMapDir(projectId);
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${commit}.md`);
  if (!focused && cache && !dirty && !force && existsSync(outPath)) {
    const content = readFileSync(outPath, 'utf8');
    return { path: outPath, content, meta: { projectId, root, commit, dirty: false, cacheHit: true, bytes: statSync(outPath).size, budget: effectiveBudget, topFiles: topRankedFiles(content) } };
  }

  // Keep aider's tags cache out of the target repo — one cache dir per project
  // under ~/.golem so reuse survives but the working tree stays clean.
  const cacheDir = path.join(golemHome(), 'repomap', '.tags-cache', projectId);
  mkdirSync(cacheDir, { recursive: true });
  const run = runExternalTool('aiderRepomap', {
    argv: ['python', '-c', AIDER_WRAPPER],
    input: JSON.stringify({ root, files, budget: effectiveBudget, max_context_window: CONTEXT_WINDOW, cache_dir: cacheDir, focus: focus || {}, force_refresh: force }),
    cwd: root,
  });
  const cleaned = stripToolNoise(run.stdout);
  const safe = applySafetyNet(cleaned);
  const header = projectHeader({ projectId, root, commit, dirty, budget: effectiveBudget, focus, generatedAt, version, warnings: safe.warnings });
  const content = `${header}${safe.text || '(no repo map content produced)'}\n`;
  if (!focused && cache) {
    writeFileSync(outPath, content, 'utf8');
    pruneMaps(dir);
  }
  return {
    path: focused || !cache ? null : outPath,
    content,
    meta: {
      projectId,
      root,
      commit,
      dirty,
      cacheHit: false,
      focused,
      bytes: Buffer.byteLength(content, 'utf8'),
      budget: effectiveBudget,
      elapsed_ms: run.elapsed_ms,
      backend: `${run.package}==${run.pinnedVersion}`,
      runner: run.runner,
      warnings: safe.warnings,
      topFiles: topRankedFiles(content),
    },
  };
}

export async function generateRepoMap(startPath, opts = {}) {
  const result = await generateMap(startPath, opts);
  return {
    path: result.path,
    projectId: result.meta.projectId,
    root: result.meta.root,
    commit: result.meta.commit,
    dirty: result.meta.dirty,
    cacheHit: result.meta.cacheHit,
    bytes: result.meta.bytes,
    meta: result.meta,
    content: result.content,
  };
}

function claudeLspServers() {
  const res = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return [...res.stdout.matchAll(/❯ ([a-z0-9-]+)-lsp@[^\n]+\n\s+Version:[^\n]+\n\s+Scope:[^\n]+\n\s+Status: ✔ enabled/g)]
    .map((m) => m[1]);
}

function opencodeLspServers(root) {
  const help = spawnSync('opencode', ['debug', 'lsp', '--help'], { cwd: root, encoding: 'utf8' });
  if (help.status !== 0) return [];
  let files = [];
  try {
    files = gitTrackedRegularFiles(root);
  } catch {
    return [];
  }
  const servers = new Set();
  if (files.some((f) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f))) servers.add('typescript (opencode-native)');
  if (files.some((f) => f.endsWith('.py'))) servers.add('python (opencode-native)');
  if (files.some((f) => f.endsWith('.swift'))) servers.add('swift (opencode-native)');
  return [...servers];
}

export async function detectLspCapability(startPath) {
  const root = await resolveProjectRoot(startPath || process.cwd());
  const servers = [...new Set([...claudeLspServers(), ...opencodeLspServers(root)])].sort();
  return {
    available: servers.length > 0,
    servers,
    checked_at: new Date().toISOString(),
  };
}

export async function updateProjectLsp(startPath) {
  const root = await resolveProjectRoot(startPath || process.cwd());
  const id = projectIdFor(root);
  const lsp = await detectLspCapability(root);
  let doc = { version: 1, projects: [] };
  try {
    doc = JSON.parse(readFileSync(projectsJsonPath(), 'utf8'));
  } catch {
    // Create a minimal registry if this is the first golem command in a sandbox.
  }
  const projects = Array.isArray(doc.projects) ? doc.projects : [];
  const idx = projects.findIndex((p) => p?.id === id || path.resolve(p?.path || '') === root);
  const entry = { id, name: path.basename(root), path: root, kind: 'auto', ...projects[idx], lsp };
  if (idx >= 0) projects[idx] = entry;
  else projects.push(entry);
  mkdirSync(path.dirname(projectsJsonPath()), { recursive: true });
  writeFileSync(projectsJsonPath(), JSON.stringify({ ...doc, version: doc.version ?? 1, projects }, null, 2) + '\n');
  return { projectId: id, root, lsp };
}

export function formatRepoMapLine(map) {
  if (!map) return null;
  return `Repo map: ${map.file} (commit ${shortCommit(map.commit)}${map.dirty ? ', dirty' : ''})`;
}
