import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as compiler from '../../lib/compiler/engine.js';
import * as ccAdapter from '../../lib/compiler/adapters/cc.js';
import * as ocAdapter from '../../lib/compiler/adapters/opencode.js';
import { loadConfig, saveConfig } from '../../lib/golem-config.js';
import { golemHome, projectsJsonPath, renderDirFor } from '../../lib/golem-home.js';
import { projectIdFor } from '../../lib/project-id.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SUBSTRATE_ROOT = path.join(REPO_ROOT, 'substrate');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const SYNC_TIMEOUT_MS = 30_000;

const TARGETS = [
  { id: 'claudecode', target: 'cc', label: 'Claude Code' },
  { id: 'opencode', target: 'opencode', label: 'opencode' },
];

const CAPABILITY_WARNINGS = {
  opencode: [
    'opencode has no Claude Code Stop-hook channel; lifecycle parity is provided by the runtime shim where opencode exposes events.',
    'opencode renders agents and skills into separate harness-native locations, plus a managed opencode.jsonc config fragment.',
  ],
};

const GLOBAL_ARTIFACTS = ['skills', 'agents', 'commands', 'hooks', 'mcp', 'config-fragment'];

const MANAGED_ELSEWHERE = {
  opencode: {
    hooks: 'runtime shim',
    mcp: 'config merge',
  },
};

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function readLockfile() {
  try { return compiler.readLockfile(); }
  catch { return { version: 1, targets: {}, projects: {} }; }
}

function lockKey(target, outDir) {
  return `${target}::${outDir}`;
}

function lockEntry(lock, target, outDir, projectId = null) {
  const bucket = projectId ? lock.projects?.[projectId]?.targets : lock.targets;
  return bucket?.[lockKey(target, outDir)] ?? null;
}

function statusFromDrift(res) {
  // Matrix cells check one artifact subset from a larger render target. Other
  // artifact lock entries appear as orphans in that subset, so cell drift is
  // determined by the subset's own changed/new/tampered files.
  if ((res.drifted ?? []).length === 0) return 'in_sync';
  if ((res.drifted ?? []).some((d) => d.reason === 'tampered')) return 'error';
  return 'drifted';
}

function summarizeDrift(res) {
  return {
    clean: !!res.clean,
    drifted: res.drifted ?? [],
    orphaned: res.orphaned ?? [],
    drifted_count: (res.drifted ?? []).length,
    orphaned_count: (res.orphaned ?? []).length,
  };
}

function cell({ harness, scope, artifact, target, outDir, items, enabled, projectId = null, config = null }) {
  const base = { harness, scope, artifact, target, out_dir: outDir, status: 'disabled', details: null, lock: null, warnings: CAPABILITY_WARNINGS[harness] ?? [] };
  if (!enabled) return base;
  try {
    const drift = compiler.checkDrift({ target, outDir, items, projectId });
    const entry = lockEntry(readLockfile(), target, outDir, projectId);
    return {
      ...base,
      status: statusFromDrift(drift),
      details: summarizeDrift(drift),
      lock: entry ? {
        synced_at: entry.synced_at ?? null,
        package_version: readLockfile().package_version ?? null,
        file_count: Object.keys(entry.files ?? {}).length,
      } : null,
      config,
    };
  } catch (err) {
    return { ...base, status: 'error', error: String(err?.message ?? err), config };
  }
}

function neutralCell({ harness, scope = 'global', artifact, target, enabled, status, label, details = null }) {
  return {
    harness,
    scope,
    artifact,
    target,
    out_dir: null,
    status: enabled ? status : 'disabled',
    label: enabled ? label : null,
    details,
    lock: null,
    warnings: CAPABILITY_WARNINGS[harness] ?? [],
  };
}

function artifactTypeForCc(relPath) {
  if (relPath.startsWith('skills/')) return 'skills';
  if (relPath.startsWith('agents/')) return 'agents';
  if (relPath.startsWith('hooks/')) return 'hooks';
  if (relPath === '.mcp.json' || relPath.startsWith('mcp/')) return 'mcp';
  if (relPath.startsWith('.claude-plugin/') || relPath === 'README.md') return 'config-fragment';
  return 'config-fragment';
}

function splitItems(items, classifier) {
  const grouped = new Map();
  for (const item of items) {
    const kind = classifier(item.outputRelPath, item);
    const arr = grouped.get(kind) ?? [];
    arr.push(item);
    grouped.set(kind, arr);
  }
  return grouped;
}

function readProjects() {
  try {
    const json = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(json.projects) ? json.projects.filter((p) => p.path) : [];
  } catch {
    return [];
  }
}

function resolveProject(projectValue) {
  if (!projectValue) return null;
  for (const p of readProjects()) {
    const pid = p.project_id || p.id || projectIdFor(p.path);
    if (projectValue === pid || projectValue === p.id || projectValue === p.path) return { ...p, project_id: pid };
  }
  return { id: projectValue, project_id: projectValue, path: projectValue };
}

function resolveOpencodeBin() {
  const probe = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  const fallback = path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode');
  return fs.existsSync(fallback) ? fallback : null;
}

function opencodeVersion(bin = resolveOpencodeBin()) {
  if (!bin) return null;
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function validateOpencodeConfig(bin) {
  if (!bin) return { ok: true, skipped: true };
  const res = spawnSync(bin, ['debug', 'config'], { encoding: 'utf8' });
  if (res.status === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || `exit ${res.status}`).trim() };
}

function buildStatus({ project = null } = {}) {
  const cfg = loadConfig();
  const lock = readLockfile();
  const version = packageVersion();
  const status = {
    generated_at: new Date().toISOString(),
    golem_home: golemHome(),
    package_version: version,
    lockfile: { version: lock.version ?? null, package_version: lock.package_version ?? null },
    config: substrateConfigShape(cfg),
    warnings: CAPABILITY_WARNINGS,
    global: [],
    projects: [],
    rollup: { in_sync: 0, drifted: 0, disabled: 0, error: 0 },
  };

  for (const row of globalCells(cfg)) status.global.push(row);
  for (const p of project ? [resolveProject(project)].filter(Boolean) : readProjects().map((p) => ({ ...p, project_id: p.project_id || p.id || projectIdFor(p.path) }))) {
    const cells = projectCells(cfg, p);
    if (cells.length) status.projects.push({ project_id: p.project_id, id: p.id ?? p.project_id, name: p.name ?? path.basename(p.path), path: p.path, cells });
  }

  for (const row of [...status.global, ...status.projects.flatMap((p) => p.cells)]) {
    status.rollup[row.status] = (status.rollup[row.status] ?? 0) + 1;
  }
  return status;
}

function globalCells(cfg) {
  const root = SUBSTRATE_ROOT;
  const rows = [];
  const ccEnabled = cfg.harnesses?.claudecode?.enabled !== false;
  const ccItems = ccAdapter.buildPlan({ substrateRoot: root, repoRoot: REPO_ROOT, packageVersion: packageVersion() });
  const ccGroups = splitItems(ccItems, artifactTypeForCc);
  for (const artifact of GLOBAL_ARTIFACTS) {
    const items = ccGroups.get(artifact) ?? [];
    rows.push(items.length
      ? cell({ harness: 'claudecode', scope: 'global', artifact, target: 'cc', outDir: renderDirFor('cc'), items, enabled: ccEnabled })
      : neutralCell({ harness: 'claudecode', artifact, target: 'cc', enabled: ccEnabled, status: 'empty', label: 'empty', details: { clean: true, drifted_count: 0, orphaned_count: 0 } }));
  }

  const ocEnabled = !!cfg.harnesses?.opencode?.enabled;
  const ocAgentItems = ocAdapter.buildAgentPlan({ substrateRoot: root });
  const ocSkillItems = ocAdapter.buildSkillPlan({ substrateRoot: root });
  const ocRows = new Map([
    ['agents', cell({ harness: 'opencode', scope: 'global', artifact: 'agents', target: 'opencode', outDir: ocAdapter.agentOutDir(), items: ocAgentItems, enabled: ocEnabled, config: { testedVersion: cfg.harnesses?.opencode?.testedVersion ?? null, currentVersion: opencodeVersion() } })],
    ['skills', cell({ harness: 'opencode', scope: 'global', artifact: 'skills', target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: ocSkillItems, enabled: ocEnabled })],
    ['config-fragment', opencodeConfigCell(cfg, ocEnabled)],
  ]);
  for (const artifact of GLOBAL_ARTIFACTS) {
    rows.push(ocRows.get(artifact) ?? neutralCell({
      harness: 'opencode',
      artifact,
      target: 'opencode',
      enabled: ocEnabled,
      status: MANAGED_ELSEWHERE.opencode[artifact] ? 'managed' : 'empty',
      label: MANAGED_ELSEWHERE.opencode[artifact] ?? 'empty',
      details: { clean: true, drifted_count: 0, orphaned_count: 0 },
    }));
  }
  return rows;
}

function opencodeConfigCell(cfg, enabled) {
  const outDir = path.dirname(ocAdapter.opencodeConfigPath());
  const base = { harness: 'opencode', scope: 'global', artifact: 'config-fragment', target: 'opencode', out_dir: ocAdapter.opencodeConfigPath(), status: enabled ? 'in_sync' : 'disabled', details: null, lock: null, warnings: CAPABILITY_WARNINGS.opencode, config: { testedVersion: cfg.harnesses?.opencode?.testedVersion ?? null, currentVersion: opencodeVersion() } };
  if (!enabled) return base;
  try {
    const current = fs.existsSync(ocAdapter.opencodeConfigPath()) ? fs.readFileSync(ocAdapter.opencodeConfigPath(), 'utf8') : '';
    const next = ocAdapter.computeConfigText(current || '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', ocAdapter.buildConfigMerge({ repoRoot: REPO_ROOT }));
    return { ...base, status: current === next ? 'in_sync' : 'drifted', out_dir: outDir, details: { clean: current === next, drifted_count: current === next ? 0 : 1, orphaned_count: 0 } };
  } catch (err) {
    return { ...base, status: 'error', error: String(err?.message ?? err) };
  }
}

function projectCells(cfg, project) {
  if (!project?.path) return [];
  const root = SUBSTRATE_ROOT;
  const rows = [];
  const projectId = project.project_id || project.id || projectIdFor(project.path);
  const ccEnabled = cfg.harnesses?.claudecode?.enabled !== false;
  const ccItems = ccAdapter.buildProjectPlan({ substrateRoot: root });
  if (ccItems.length) rows.push(cell({ harness: 'claudecode', scope: 'project', artifact: 'config-fragment', target: 'cc', outDir: project.path, items: ccItems, enabled: ccEnabled, projectId }));

  const ocEnabled = !!cfg.harnesses?.opencode?.enabled;
  const ocAgentItems = ocAdapter.buildProjectAgentPlan({ substrateRoot: root });
  const ocSkillItems = ocAdapter.buildProjectSkillPlan({ substrateRoot: root });
  if (ocAgentItems.length) rows.push(cell({ harness: 'opencode', scope: 'project', artifact: 'agents', target: 'opencode', outDir: ocAdapter.projectAgentOutDir(project.path), items: ocAgentItems, enabled: ocEnabled, projectId }));
  if (ocSkillItems.length) rows.push(cell({ harness: 'opencode', scope: 'project', artifact: 'skills', target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(project.path), items: ocSkillItems, enabled: ocEnabled, projectId }));
  return rows;
}

function substrateConfigShape(cfg = loadConfig()) {
  return {
    harnesses: Object.fromEntries(Object.entries(cfg.harnesses ?? {}).map(([id, h]) => [id, {
      enabled: !!h?.enabled,
      modelMap: h?.modelMap ?? {},
      testedVersion: h?.testedVersion ?? null,
    }])),
  };
}

function validateConfigPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('body must be an object'), { statusCode: 400 });
  if (body.harnesses != null && (typeof body.harnesses !== 'object' || Array.isArray(body.harnesses))) throw Object.assign(new Error('harnesses must be an object'), { statusCode: 400 });
  for (const [id, h] of Object.entries(body.harnesses ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Object.assign(new Error(`invalid harness id: ${id}`), { statusCode: 400 });
    if (h == null || typeof h !== 'object' || Array.isArray(h)) throw Object.assign(new Error(`harness ${id} must be an object`), { statusCode: 400 });
    if ('enabled' in h && typeof h.enabled !== 'boolean') throw Object.assign(new Error(`harness ${id}.enabled must be boolean`), { statusCode: 400 });
    if ('modelMap' in h && (typeof h.modelMap !== 'object' || Array.isArray(h.modelMap) || h.modelMap == null)) throw Object.assign(new Error(`harness ${id}.modelMap must be an object`), { statusCode: 400 });
  }
}

function mergeConfigPatch(current, patch) {
  const next = { ...current, harnesses: { ...(current.harnesses ?? {}) } };
  for (const [id, h] of Object.entries(patch.harnesses ?? {})) {
    next.harnesses[id] = { ...(next.harnesses[id] ?? {}), ...h };
  }
  return next;
}

function renderSummary(res) {
  return { written: res.written.length, unchanged: res.unchanged.length, pruned: res.pruned.length, tampered: res.tampered.length, tampered_files: res.tampered };
}

function syncTarget({ harness, project = null, force = false }) {
  const cfg = loadConfig();
  const started = Date.now();
  const targetDef = TARGETS.find((t) => t.id === harness || t.target === harness);
  if (!targetDef) throw Object.assign(new Error(`unknown target: ${harness}`), { statusCode: 400 });
  if (targetDef.id === 'opencode' && !cfg.harnesses?.opencode?.enabled) return { harness: targetDef.id, skipped: true, status: 'disabled' };
  if (targetDef.id === 'claudecode' && cfg.harnesses?.claudecode?.enabled === false) return { harness: targetDef.id, skipped: true, status: 'disabled' };

  const root = SUBSTRATE_ROOT;
  const pkg = packageVersion();
  const results = [];
  const p = project ? resolveProject(project) : null;
  if (Date.now() - started > SYNC_TIMEOUT_MS) throw new Error('sync timed out before start');

  if (targetDef.id === 'claudecode') {
    if (p) {
      const items = ccAdapter.buildProjectPlan({ substrateRoot: root });
      const res = compiler.render({ target: 'cc', outDir: p.path, items, packageVersion: pkg, force, projectId: p.project_id || p.id || projectIdFor(p.path) });
      results.push({ artifact: 'project', out_dir: p.path, ...renderSummary(res) });
    } else {
      const outDir = renderDirFor('cc');
      const items = ccAdapter.buildPlan({ substrateRoot: root, repoRoot: REPO_ROOT, packageVersion: pkg });
      const res = compiler.render({ target: 'cc', outDir, items, packageVersion: pkg, force });
      ccAdapter.syncMcpChannelDeps({ repoRoot: REPO_ROOT, outDir });
      results.push({ artifact: 'global', out_dir: outDir, ...renderSummary(res) });
    }
  }

  if (targetDef.id === 'opencode') {
    if (p) {
      const projectId = p.project_id || p.id || projectIdFor(p.path);
      const agentItems = ocAdapter.buildProjectAgentPlan({ substrateRoot: root });
      const skillItems = ocAdapter.buildProjectSkillPlan({ substrateRoot: root });
      results.push({ artifact: 'agents', out_dir: ocAdapter.projectAgentOutDir(p.path), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.projectAgentOutDir(p.path), items: agentItems, packageVersion: pkg, force, projectId })) });
      results.push({ artifact: 'skills', out_dir: ocAdapter.projectSkillsOutDir(p.path), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(p.path), items: skillItems, packageVersion: pkg, force, projectId })) });
    } else {
      const agentItems = ocAdapter.buildAgentPlan({ substrateRoot: root });
      const skillItems = ocAdapter.buildSkillPlan({ substrateRoot: root });
      results.push({ artifact: 'agents', out_dir: ocAdapter.agentOutDir(), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.agentOutDir(), items: agentItems, packageVersion: pkg, force })) });
      results.push({ artifact: 'skills', out_dir: ocAdapter.skillsOutDir(), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: skillItems, packageVersion: pkg, force })) });
      const bin = resolveOpencodeBin();
      const merge = ocAdapter.buildConfigMerge({ repoRoot: REPO_ROOT });
      const configRes = ocAdapter.applyConfigMerge({ configPath: ocAdapter.opencodeConfigPath(), merge, validate: () => validateOpencodeConfig(bin) });
      if (configRes.restored) throw new Error(`opencode config validation failed: ${configRes.error}`);
      if (bin) {
        const ver = opencodeVersion(bin);
        if (ver) {
          const next = loadConfig();
          next.harnesses = next.harnesses ?? {};
          next.harnesses.opencode = { ...next.harnesses.opencode, testedVersion: ver };
          saveConfig(next);
        }
      }
      results.push({ artifact: 'config-fragment', out_dir: ocAdapter.opencodeConfigPath(), changed: !!configRes.changed, validation_skipped: !bin });
    }
  }

  return { harness: targetDef.id, status: 'ok', elapsed_ms: Date.now() - started, results };
}

export async function registerSubstrateRoutes(fastify) {
  fastify.get('/api/substrate/config', async () => substrateConfigShape(loadConfig()));

  fastify.put('/api/substrate/config', async (req, reply) => {
    try {
      validateConfigPatch(req.body ?? {});
      const next = mergeConfigPatch(loadConfig(), req.body ?? {});
      saveConfig(next);
      return substrateConfigShape(next);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/substrate/status', async (req) => buildStatus({ project: req.query?.project || null }));

  fastify.post('/api/substrate/sync', async (req, reply) => {
    const body = req.body ?? {};
    const targets = body.target ? [body.target] : TARGETS.map((t) => t.id);
    const out = { generated_at: new Date().toISOString(), timeout_ms: SYNC_TIMEOUT_MS, project: body.project || null, results: [] };
    try {
      for (const target of targets) out.results.push(syncTarget({ harness: target, project: body.project || null, force: body.force === true }));
      out.status = out.results.some((r) => r.status === 'ok') ? 'ok' : 'skipped';
      return out;
    } catch (err) {
      out.status = 'error';
      out.error = String(err?.message ?? err);
      return reply.code(err.statusCode || 500).send(out);
    }
  });
}
