import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { golemHome, projectsJsonPath } from './golem-home.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';

const GENERATOR = 'golem-regex-repomap';
const TARGET_BYTES = 11_500;
const MAX_DIR_ENTRIES = 24;
const KEEP_MAPS = 3;
const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sh']);

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
  const res = runGit(['rev-parse', 'HEAD'], root);
  return res.stdout.trim();
}

function isDirty(root) {
  const res = runGit(['status', '--porcelain'], root, { allowFail: true });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function gitFiles(root) {
  const res = runGit(['ls-files', '-co', '--exclude-standard'], root);
  return res.stdout.split('\n').filter(Boolean).sort();
}

function insertTree(node, parts) {
  if (!parts.length) return;
  const [head, ...tail] = parts;
  node.children ??= new Map();
  if (!node.children.has(head)) node.children.set(head, { name: head, children: null });
  insertTree(node.children.get(head), tail);
}

function renderTree(files) {
  const root = { name: '.', children: new Map() };
  for (const file of files) insertTree(root, file.split('/'));
  const lines = ['## Tree', '', '.'];
  function walk(node, prefix = '') {
    const entries = [...(node.children ?? new Map()).values()]
      .sort((a, b) => Number(!!a.children) - Number(!!b.children) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, MAX_DIR_ENTRIES);
    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i];
      const last = i === shown.length - 1 && entries.length <= MAX_DIR_ENTRIES;
      const branch = last ? '└── ' : '├── ';
      const nextPrefix = `${prefix}${last ? '    ' : '│   '}`;
      lines.push(`${prefix}${branch}${entry.name}${entry.children ? '/' : ''}`);
      if (entry.children) walk(entry, nextPrefix);
    }
    if (entries.length > MAX_DIR_ENTRIES) lines.push(`${prefix}└── … (+${entries.length - MAX_DIR_ENTRIES} more)`);
  }
  walk(root);
  return lines.join('\n');
}

function cleanSignature(line) {
  return line.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function extractSymbols(file, text) {
  const ext = path.extname(file);
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('//') || s.startsWith('#')) continue;
    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      if (/^export\s+(async\s+)?function\s+\w+/.test(s) || /^export\s+class\s+\w+/.test(s) || /^export\s+(const|let|var)\s+\w+/.test(s) || /^export\s+async\s+function\s+\w+/.test(s)) out.push(cleanSignature(s));
      else if (/^(async\s+)?function\s+\w+/.test(s) || /^class\s+\w+/.test(s)) out.push(cleanSignature(s));
    } else if (ext === '.py') {
      if (/^(async\s+)?def\s+\w+\(.*\):/.test(s) || /^class\s+\w+/.test(s)) out.push(cleanSignature(s));
    } else if (ext === '.sh') {
      if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(s) || /^function\s+[A-Za-z_][A-Za-z0-9_]*/.test(s)) out.push(cleanSignature(s));
    }
    if (out.length >= 12) break;
  }
  return out;
}

function renderSymbols(root, files, budgetLeft) {
  const lines = ['## Symbols', ''];
  let truncated = 0;
  for (const file of files) {
    if (!SOURCE_EXTS.has(path.extname(file))) continue;
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const symbols = extractSymbols(file, text);
    if (!symbols.length) continue;
    const block = [`### ${file}`, ...symbols.map((s) => `- ${s}`), ''];
    const next = [...lines, ...block].join('\n');
    if (Buffer.byteLength(next, 'utf8') > budgetLeft) {
      truncated += 1;
      continue;
    }
    lines.push(...block);
  }
  if (truncated) lines.push(`… (+${truncated} more symbol files)`);
  return lines.join('\n');
}

function pruneMaps(dir, keep = KEEP_MAPS) {
  if (!existsSync(dir)) return;
  const maps = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, file: path.join(dir, name), mtimeMs: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of maps.slice(keep)) unlinkSync(old.file);
}

export async function generateRepoMap(startPath, { force = false, version = 'unknown' } = {}) {
  const root = await resolveProjectRoot(startPath || process.cwd());
  const projectId = projectIdFor(root);
  const commit = currentCommit(root);
  const dirty = isDirty(root);
  const dir = repoMapDir(projectId);
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${commit}.md`);
  if (!dirty && !force && existsSync(outPath)) {
    return { path: outPath, projectId, root, commit, dirty: false, cacheHit: true, bytes: statSync(outPath).size };
  }

  const files = gitFiles(root);
  const header = [
    '# Repo map',
    '',
    `project: ${projectId}`,
    `root: ${root}`,
    `commit: ${commit}`,
    `generated-at: ${new Date().toISOString()}`,
    `dirty: ${dirty ? 'true' : 'false'}`,
    `generator: ${GENERATOR}`,
    `version: ${version}`,
    '',
    'Orientation only; verify from source before editing.',
    '',
  ].join('\n');
  const tree = renderTree(files);
  const used = Buffer.byteLength(`${header}${tree}\n\n`, 'utf8');
  const symbols = renderSymbols(root, files, Math.max(2_000, TARGET_BYTES - used));
  let body = `${header}${tree}\n\n${symbols}\n`;
  if (Buffer.byteLength(body, 'utf8') > TARGET_BYTES) {
    body = `${body.slice(0, TARGET_BYTES - 80)}\n\n… (+truncated to repo-map budget)\n`;
  }
  writeFileSync(outPath, body, 'utf8');
  pruneMaps(dir);
  return { path: outPath, projectId, root, commit, dirty, cacheHit: false, bytes: statSync(outPath).size };
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
    files = gitFiles(root);
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
