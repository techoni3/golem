#!/usr/bin/env node
// golem — minimal Node CLI for the v4 harness.
//
// v3 subcommands removed:
//   install, cleanup, reinstall, session, project, dispatch, ack
//
// Surviving subcommands:
//   dashboard    Start the admin dashboard (node dashboard/server/index.js).
//   dashboard:restart
//                Stop and restart the admin dashboard detached.
//   doctor       Sanity-check the environment.
//   status       Dashboard health + canonical URL.
//   help         Show this message.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { golemHome, legacyConfigDir, migratedHomeDir, trackerDbPath, renderDirFor, projectsJsonPath, sessionsJsonPath } from '../lib/golem-home.js';
import { projectIdFor } from '../lib/project-id.js';
import { SESSION_ROLES, pushRoleBriefDirect, setSessionRole } from '../lib/session-role.js';
import { updateProjectLsp } from '../lib/lsp.js';
import * as compiler from '../lib/compiler/engine.js';
import * as ccAdapter from '../lib/compiler/adapters/cc.js';
import * as ocAdapter from '../lib/compiler/adapters/opencode.js';
import { isHarnessEnabled, loadConfig, saveConfig } from '../lib/golem-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLEM_ROOT = resolve(__dirname, '..');
const DASHBOARD_DIR = resolve(GOLEM_ROOT, 'dashboard');
const DASHBOARD_URL = 'http://dashboard.golem.localhost:7420';
const HEALTH_URL = `${DASHBOARD_URL}/api/health`;

const removed = new Set([
  'install',
  'cleanup',
  'reinstall',
  'session',
  'project',
  'dispatch',
  'ack',
]);

function log(line) {
  console.log(line);
}

function err(line) {
  console.error(line);
}

function fatal(code, message) {
  err(message);
  process.exit(code);
}

async function httpGetJson(url, timeoutMs = 1500) {
  const urlObj = new URL(url);
  const mod = urlObj.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function probeDashboard() {
  try {
    return { ok: true, data: await httpGetJson(HEALTH_URL) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function hasCommand(name) {
  // Using `command -v` is the most portable way on POSIX shells.
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function cmdStatus(args) {
  const wantJson = args.includes('--json');
  const probe = await probeDashboard();

  if (wantJson) {
    log(JSON.stringify({
      dashboard_url: probe.ok ? DASHBOARD_URL : null,
      dashboard_healthy: probe.ok,
      dashboard: probe.data ?? null,
      error: probe.ok ? null : probe.error,
    }, null, 2));
    return;
  }

  log('');
  log('Dashboard');
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    log(`  OK running on ${DASHBOARD_URL} (${pc} projects)`);
  } else {
    log(`  not reachable (${probe.error})`);
    log(`  start it with: golem dashboard`);
  }
}

function readSessionsRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(sessionsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function resolveSessionArg(value, sessions) {
  if (!value) return null;
  const exact = sessions.find((s) => s.session_id === value || s.name === value);
  if (exact) return exact;
  const pref = sessions.filter((s) => typeof s.session_id === 'string' && s.session_id.startsWith(value));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) {
    throw new Error(`ambiguous session prefix "${value}" (${pref.length} matches)`);
  }
  throw new Error(`session not found: ${value}`);
}

function liveSessionLines(sessions) {
  return sessions
    .slice()
    .sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
    .map((s) => `  ${s.session_id}${s.name ? `  ${s.name}` : ''}${s.project_path ? `  ${s.project_path}` : ''}`);
}

async function cmdRole(args) {
  const roleArg = args[0];
  if (!roleArg || roleArg === '-h' || roleArg === '--help') {
    log(`Usage: golem role <${SESSION_ROLES.join('|')}|clear> [--session <id-or-name>]`);
    return;
  }
  const role = roleArg === 'clear' ? null : roleArg;
  if (role != null && !SESSION_ROLES.includes(role)) {
    fatal(2, `invalid role: ${roleArg} (expected ${SESSION_ROLES.join('|')} or clear)`);
  }
  let sessionOpt = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--session') {
      sessionOpt = args[++i];
      if (!sessionOpt) fatal(2, '--session requires a value');
    } else if (a.startsWith('--session=')) {
      sessionOpt = a.slice('--session='.length);
    } else {
      fatal(2, `unknown role option: ${a}`);
    }
  }
  const sessions = readSessionsRegistry();
  let target;
  try {
    if (sessionOpt) {
      target = resolveSessionArg(sessionOpt, sessions);
    } else if (process.env.CLAUDE_CODE_SESSION_ID) {
      target = resolveSessionArg(process.env.CLAUDE_CODE_SESSION_ID, sessions);
    } else {
      const lines = liveSessionLines(sessions);
      fatal(2, `--session is required when CLAUDE_CODE_SESSION_ID is unset.${lines.length ? `\n\nKnown sessions:\n${lines.join('\n')}` : ''}`);
    }
  } catch (e) {
    fatal(2, e.message);
  }
  const updated = setSessionRole(target.session_id, role, { by: 'human:cli' });
  if (role) await pushRoleBriefDirect(updated.session_id, role, updated);
  log(JSON.stringify({
    ok: true,
    session_id: updated.session_id,
    name: updated.name ?? null,
    role: updated.role,
    role_updated_at: updated.role_updated_at,
    role_updated_by: updated.role_updated_by,
  }, null, 2));
}

async function cmdDashboard(args) {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  if (!existsSync(serverEntry)) {
    fatal(1, `dashboard server entry missing: ${serverEntry}`);
  }
  if (!existsSync(resolve(GOLEM_ROOT, 'node_modules'))) {
    fatal(1, 'root deps missing — npm install (from the repo root)');
  }

  const publicFlag = args.includes('--public');
  const env = { ...process.env };
  if (publicFlag) {
    env.HOST = '0.0.0.0';
    err('WARNING --public: dashboard binding 0.0.0.0 — reachable on your LAN with NO auth.');
    err('WARNING anyone on this network can drive sessions via /api/brief.');
  }

  const passthru = args.filter((a) => a !== '--public');
  const proc = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: GOLEM_ROOT,
    stdio: 'inherit',
    env,
  });
  proc.on('error', (e) => fatal(1, `failed to start dashboard: ${e.message}`));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** Best-effort pid of the currently-running dashboard, from its self-registered dashboard.json. */
async function readDashboardPid() {
  try {
    const doc = JSON.parse(await readFile(join(golemHome(), 'dashboard.json'), 'utf8'));
    return typeof doc?.pid === 'number' ? doc.pid : null;
  } catch {
    return null;
  }
}

/** Stop the running dashboard (SIGTERM, then SIGKILL after 3s) if one is up. Returns true if it stopped a process. */
async function stopDashboard() {
  const probe = await probeDashboard();
  if (!probe.ok) return false;
  const pid = await readDashboardPid();
  if (!pid || !isProcessAlive(pid)) {
    err('WARNING dashboard is responding but its recorded pid is stale/unreadable — leave it running and stop it manually if this migration fails.');
    return false;
  }
  log(`  stopping dashboard pid=${pid}...`);
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(200);
  if (isProcessAlive(pid)) {
    log(`  pid=${pid} still alive after 3s; sending SIGKILL`);
    process.kill(pid, 'SIGKILL');
    await sleep(500);
  }
  return true;
}

/** Start the dashboard detached (survives this CLI process exiting) and wait for it to answer /api/health. */
async function startDashboardDetached(args = []) {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  const publicFlag = args.includes('--public');
  const passthru = args.filter((a) => a !== '--public');
  const env = { ...process.env };
  if (publicFlag) env.HOST = '0.0.0.0';
  const child = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: GOLEM_ROOT,
    stdio: 'ignore',
    detached: true,
    env,
  });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const probe = await probeDashboard();
    if (probe.ok) return true;
    await sleep(300);
  }
  return false;
}

async function cmdDashboardRestart(args) {
  if (!existsSync(resolve(DASHBOARD_DIR, 'server', 'index.js'))) {
    fatal(1, `dashboard server entry missing: ${resolve(DASHBOARD_DIR, 'server', 'index.js')}`);
  }
  if (!existsSync(resolve(GOLEM_ROOT, 'node_modules'))) {
    fatal(1, 'root deps missing — npm install (from the repo root)');
  }

  log('Restarting dashboard...');
  const stopped = await stopDashboard();
  log(stopped ? '  OK dashboard stopped' : '  dashboard was not running');
  log('  starting dashboard detached...');
  const started = await startDashboardDetached(args);
  if (!started) fatal(1, '  FAIL dashboard did not come back up within 8s — start it manually: golem dashboard');
  log(`  OK dashboard responding on ${DASHBOARD_URL}`);
}

async function cmdMigrateHome(args) {
  const src = legacyConfigDir();
  const dest = migratedHomeDir();

  let srcStat = null;
  try { srcStat = lstatSync(src); } catch { /* doesn't exist */ }

  if (srcStat && srcStat.isSymbolicLink()) {
    fatal(1, `already migrated: ${src} is a symlink -> ${readlinkSync(src)}`);
  }
  if (!srcStat) {
    fatal(1, `nothing to migrate: ${src} does not exist`);
  }
  if (existsSync(dest)) {
    fatal(1, `${dest} already exists — refusing to overwrite. Resolve manually before retrying.`);
  }

  log('');
  log('golem migrate-home');
  log(`  source: ${src}`);
  log(`  dest:   ${dest}`);

  // 1. Backup tarball (parent-relative tar so the archive contains a
  //    relocatable `golem/` entry, not an absolute-path member).
  const home = homedir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(home, `golem-config-backup-${stamp}.tar.gz`);
  const rel = src.startsWith(home + '/') ? src.slice(home.length + 1) : src;
  log(`  backing up to ${backupPath} ...`);
  const tarResult = spawnSync('tar', ['-czf', backupPath, '-C', home, rel], { stdio: 'inherit' });
  if (tarResult.status !== 0) {
    fatal(1, `backup failed (tar exit ${tarResult.status}) — aborting before touching ${src}`);
  }
  if (!existsSync(backupPath)) {
    fatal(1, `backup tarball missing after tar reported success — aborting: ${backupPath}`);
  }
  log(`  OK backup written: ${backupPath}`);

  // 2. Stop the dashboard (open SQLite handle on tracker.db inside src).
  const stopped = await stopDashboard();
  log(stopped ? '  OK dashboard stopped' : '  dashboard was not running');

  // 3 + 4. Move, then symlink the old path to the new one.
  try {
    renameSync(src, dest);
    symlinkSync(dest, src);
  } catch (e) {
    fatal(1, `move/symlink failed: ${e.message}. Backup is intact at ${backupPath} — restore with: tar -xzf ${backupPath} -C ${home}`);
  }
  log(`  OK moved ${src} -> ${dest}`);
  log(`  OK symlinked ${src} -> ${dest}`);

  // 5. Restart the dashboard.
  log('  restarting dashboard...');
  const up = await startDashboardDetached();
  if (up) {
    log('  OK dashboard responding');
  } else {
    err('  FAIL dashboard did not come back up within 8s — start it manually: golem dashboard');
  }

  log('');
  log('Rollback (one operation): ');
  log(`  rm "${src}" && mv "${dest}" "${src}" && golem dashboard`);
  log(`  (or restore from backup: tar -xzf ${backupPath} -C ${home})`);
}

const ADAPTERS = { cc: ccAdapter };
const KNOWN_TARGETS = ['cc', 'cc-marketplace', 'opencode'];

/** Resolve the opencode binary: PATH first, then the default install location. */
function resolveOpencodeBin() {
  const probe = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  const fallback = join(homedir(), '.opencode', 'bin', 'opencode');
  return existsSync(fallback) ? fallback : null;
}

/** `opencode --version` output, or null if the binary can't be found/run. */
function opencodeVersion(bin) {
  if (!bin) return null;
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** A validator that runs `opencode debug config` (the real tool, not the schema). */
function makeOpencodeValidator(bin) {
  if (!bin) return null;
  return () => {
    const res = spawnSync(bin, ['debug', 'config'], { encoding: 'utf8' });
    if (res.status === 0) return { ok: true };
    const msg = (res.stderr || res.stdout || `exit ${res.status}`).trim().split('\n').slice(0, 6).join('\n');
    return { ok: false, error: msg };
  };
}

function readPackageVersion() {
  return JSON.parse(readFileSync(resolve(GOLEM_ROOT, 'package.json'), 'utf8')).version;
}

function substrateRoot() {
  return process.env.GOLEM_SUBSTRATE_ROOT ? resolve(process.env.GOLEM_SUBSTRATE_ROOT) : resolve(GOLEM_ROOT, 'substrate');
}

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

function normalizeTarget(target) {
  if (target === 'claudecode') return 'cc';
  if (target === 'cc' || target === 'cc-marketplace' || target === 'opencode') return target;
  fatal(2, `Unknown sync target/harness: ${target} (known: ${KNOWN_TARGETS.join(', ')}, claudecode)`);
}

function planForTarget(target) {
  const root = substrateRoot();
  if (target === 'cc-marketplace') {
    return ccAdapter.buildMarketplacePlan({ substrateRoot: root });
  }
  const adapter = ADAPTERS[target];
  if (!adapter) fatal(2, `Unknown sync target: ${target} (known: ${KNOWN_TARGETS.join(', ')})`);
  return adapter.buildPlan({ substrateRoot: root, repoRoot: GOLEM_ROOT, packageVersion: readPackageVersion() });
}

function knownProjects() {
  try {
    const doc = JSON.parse(readFileSync(projectsJsonPath(), 'utf8'));
    return (doc.projects ?? []).filter((p) => p?.path && existsSync(p.path));
  } catch {
    return [];
  }
}

function printDrift({ clean, drifted, orphaned }) {
  if (clean) {
    log('  OK clean — no drift');
    return;
  }
  if (drifted.length) {
    log('');
    log('  drifted:');
    for (const d of drifted) log(`    ${d.reason.padEnd(9)} ${d.key}`);
  }
  if (orphaned.length) {
    log('');
    log('  orphaned (source removed, output would be pruned):');
    for (const o of orphaned) log(`    orphan    ${o.key}`);
  }
}

function warnVisibleGeneratedFiles({ projectRoot, outDir, items, result }) {
  const byKey = new Map(items.map((item) => [item.key, item.outputRelPath]));
  const relPaths = [];
  for (const key of new Set([...(result.written ?? []), ...(result.unchanged ?? [])])) {
    const relOut = byKey.get(key);
    if (!relOut) continue;
    relPaths.push(pathRelative(projectRoot, join(outDir, relOut)));
  }
  if (!relPaths.length) return;
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relPaths], { cwd: projectRoot, encoding: 'utf8' });
  if (status.status !== 0) return;
  const visible = status.stdout.split('\0')
    .filter(Boolean)
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3));
  if (!visible.length) return;
  err('');
  err('  WARNING project render has generated files that are untracked and not gitignored:');
  for (const rel of visible) err(`    ${rel}`);
  err('  Add an ignore rule or intentionally track them before using project-scoped artifacts in this repo.');
}

function pathRelative(from, to) {
  const rel = relative(from, to);
  return rel || '.';
}

async function cmdSync(args) {
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  const explicitTarget = optionValue(args, '--target') || optionValue(args, '--harness');
  const target = normalizeTarget(explicitTarget || 'cc');
  const projectArg = optionValue(args, '--project');

  if (checkOnly && !explicitTarget && !projectArg && !optionValue(args, '--out') && args.filter((a) => a !== '--check').length === 0) {
    return cmdSyncCheckAll();
  }

  if (projectArg) {
    if (target === 'cc-marketplace') fatal(2, '--project is not valid with cc-marketplace');
    return cmdSyncProject({ target, projectRoot: resolve(projectArg), checkOnly, force });
  }

  if (target === 'opencode') {
    return cmdSyncOpencode({ checkOnly, force });
  }

  const outDir = optionValue(args, '--out') ? resolve(optionValue(args, '--out')) : renderDirFor(target);

  const items = planForTarget(target);

  if (checkOnly) {
    const { clean, drifted, orphaned } = compiler.checkDrift({ target, outDir, items });
    log('');
    log(`golem sync --check --target ${target}`);
    log(`  out: ${outDir}`);
    printDrift({ clean, drifted, orphaned });
    if (!clean) process.exit(1);
    return;
  }

  const { written, unchanged, tampered, pruned } = compiler.render({
    target,
    outDir,
    items,
    packageVersion: readPackageVersion(),
    force,
  });
  if (target === 'cc') {
    ccAdapter.syncMcpChannelDeps({ repoRoot: GOLEM_ROOT, outDir });
  }
  if (target === 'cc-marketplace') {
    ccAdapter.ensureMarketplacePluginLink({ ccPluginDir: renderDirFor('cc'), marketplaceOutDir: outDir });
  }

  log('');
  log(`golem sync --target ${target}`);
  log(`  out: ${outDir}`);
  log(`  written: ${written.length}, unchanged: ${unchanged.length}, pruned: ${pruned.length}, tampered: ${tampered.length}`);
  if (tampered.length) {
    log('');
    err('  TAMPER — refused to overwrite (hand-edited outside sync); re-run with --force to overwrite:');
    for (const t of tampered) err(`    ${t.outputRelPath}`);
    process.exit(1);
  }
  if (pruned.length) {
    log('');
    log('  pruned (source removed):');
    for (const p of pruned) log(`    ${p.outputRelPath}`);
  }
}

async function cmdSyncProject({ target, projectRoot, checkOnly, force }) {
  const root = substrateRoot();
  const packageVersion = readPackageVersion();
  const projectId = projectIdFor(projectRoot);
  log('');
  log(`golem sync --target ${target}${checkOnly ? ' --check' : ''} --project ${projectRoot}`);
  log(`  project_id: ${projectId}`);

  if (target === 'opencode') {
    if (!isHarnessEnabled('opencode')) {
      log('  · opencode harness is disabled in ~/.golem/config.json — skipping (not drift).');
      return;
    }
    const agentItems = ocAdapter.buildProjectAgentPlan({ substrateRoot: root });
    const skillItems = ocAdapter.buildProjectSkillPlan({ substrateRoot: root });
    const agentDir = ocAdapter.projectAgentOutDir(projectRoot);
    const skillsDir = ocAdapter.projectSkillsOutDir(projectRoot);
    if (checkOnly) {
      const a = compiler.checkDrift({ target: 'opencode', outDir: agentDir, items: agentItems, projectId });
      const s = compiler.checkDrift({ target: 'opencode', outDir: skillsDir, items: skillItems, projectId });
      log(`  agents out: ${agentDir}`);
      log(`  skills out: ${skillsDir}`);
      const clean = a.clean && s.clean;
      printDrift({ clean, drifted: [...a.drifted, ...s.drifted], orphaned: [...a.orphaned, ...s.orphaned] });
      if (!clean) process.exit(1);
      return;
    }
    const ra = compiler.render({ target: 'opencode', outDir: agentDir, items: agentItems, packageVersion, force, projectId });
    const rs = compiler.render({ target: 'opencode', outDir: skillsDir, items: skillItems, packageVersion, force, projectId });
    log(`  agents out: ${agentDir}`);
    log(`    written: ${ra.written.length}, unchanged: ${ra.unchanged.length}, pruned: ${ra.pruned.length}, tampered: ${ra.tampered.length}`);
    log(`  skills out: ${skillsDir}`);
    log(`    written: ${rs.written.length}, unchanged: ${rs.unchanged.length}, pruned: ${rs.pruned.length}, tampered: ${rs.tampered.length}`);
    warnVisibleGeneratedFiles({ projectRoot, outDir: agentDir, items: agentItems, result: ra });
    warnVisibleGeneratedFiles({ projectRoot, outDir: skillsDir, items: skillItems, result: rs });
    const tampered = [...ra.tampered, ...rs.tampered];
    if (tampered.length) {
      log('');
      err('  TAMPER — refused to overwrite (hand-edited outside sync); re-run with --force:');
      for (const t of tampered) err(`    ${t.outputRelPath}`);
      process.exit(1);
    }
    return;
  }

  const outDir = projectRoot;
  const items = ccAdapter.buildProjectPlan({ substrateRoot: root, repoRoot: GOLEM_ROOT, packageVersion });
  if (checkOnly) {
    const res = compiler.checkDrift({ target: 'cc', outDir, items, projectId });
    log(`  out: ${outDir}`);
    printDrift(res);
    if (!res.clean) process.exit(1);
    return;
  }
  const res = compiler.render({ target: 'cc', outDir, items, packageVersion, force, projectId });
  log(`  out: ${outDir}`);
  log(`  written: ${res.written.length}, unchanged: ${res.unchanged.length}, pruned: ${res.pruned.length}, tampered: ${res.tampered.length}`);
  warnVisibleGeneratedFiles({ projectRoot, outDir, items, result: res });
  if (res.tampered.length) {
    log('');
    err('  TAMPER — refused to overwrite (hand-edited outside sync); re-run with --force:');
    for (const t of res.tampered) err(`    ${t.outputRelPath}`);
    process.exit(1);
  }
}

async function cmdSyncCheckAll() {
  let drift = false;
  log('');
  log('golem sync --check');

  const ccOut = renderDirFor('cc');
  const cc = compiler.checkDrift({ target: 'cc', outDir: ccOut, items: planForTarget('cc') });
  log('');
  log(`global cc: ${ccOut}`);
  printDrift(cc);
  drift = drift || !cc.clean;

  if (isHarnessEnabled('opencode')) {
    const root = substrateRoot();
    const a = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.agentOutDir(), items: ocAdapter.buildAgentPlan({ substrateRoot: root }) });
    const s = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: ocAdapter.buildSkillPlan({ substrateRoot: root }) });
    const r = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.rolesOutDir(), items: ocAdapter.buildRolePlan({ substrateRoot: root }) });
    const clean = a.clean && s.clean && r.clean;
    log('');
    log('global opencode:');
    log(`  agents out: ${ocAdapter.agentOutDir()}`);
    log(`  skills out: ${ocAdapter.skillsOutDir()}`);
    log(`  roles out: ${ocAdapter.rolesOutDir()}`);
    printDrift({ clean, drifted: [...a.drifted, ...s.drifted, ...r.drifted], orphaned: [...a.orphaned, ...s.orphaned, ...r.orphaned] });
    drift = drift || !clean;
  }

  for (const p of knownProjects()) {
    const projectId = p.id || projectIdFor(p.path);
    const ccProj = compiler.checkDrift({ target: 'cc', outDir: p.path, items: ccAdapter.buildProjectPlan({ substrateRoot: substrateRoot() }), projectId });
    log('');
    log(`project cc ${projectId}: ${p.path}`);
    printDrift(ccProj);
    drift = drift || !ccProj.clean;
    if (isHarnessEnabled('opencode')) {
      const root = substrateRoot();
      const a = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.projectAgentOutDir(p.path), items: ocAdapter.buildProjectAgentPlan({ substrateRoot: root }), projectId });
      const s = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(p.path), items: ocAdapter.buildProjectSkillPlan({ substrateRoot: root }), projectId });
      const clean = a.clean && s.clean;
      log(`project opencode ${projectId}: ${p.path}`);
      printDrift({ clean, drifted: [...a.drifted, ...s.drifted], orphaned: [...a.orphaned, ...s.orphaned] });
      drift = drift || !clean;
    }
  }

  if (drift) process.exit(1);
}

/**
 * opencode sync (TKT-0576, P4). Unlike cc, opencode reads from TWO dirs — the
 * fixed global agent dir and a skills dir registered via skills.paths — plus a
 * managed opencode.jsonc merge, so it can't ride the single-outDir cmdSync
 * path. Honors the harness toggle: a disabled opencode harness is reported as
 * "disabled" and skipped (exit 0), never as drift (ADR-8).
 */
async function cmdSyncOpencode({ checkOnly, force }) {
  log('');
  log(`golem sync --target opencode${checkOnly ? ' --check' : ''}`);

  if (!isHarnessEnabled('opencode')) {
    log('  · opencode harness is disabled in ~/.golem/config.json — skipping (not drift).');
    log('    enable it there (harnesses.opencode.enabled = true) to render.');
    return;
  }

  const root = substrateRoot();
  const packageVersion = readPackageVersion();
  const agentItems = ocAdapter.buildAgentPlan({ substrateRoot: root });
  const skillItems = ocAdapter.buildSkillPlan({ substrateRoot: root });
  const roleItems = ocAdapter.buildRolePlan({ substrateRoot: root });
  const agentDir = ocAdapter.agentOutDir();
  const skillsDir = ocAdapter.skillsOutDir();
  const rolesDir = ocAdapter.rolesOutDir();

  if (checkOnly) {
    const a = compiler.checkDrift({ target: 'opencode', outDir: agentDir, items: agentItems });
    const s = compiler.checkDrift({ target: 'opencode', outDir: skillsDir, items: skillItems });
    const r = compiler.checkDrift({ target: 'opencode', outDir: rolesDir, items: roleItems });
    log(`  agents out: ${agentDir}`);
    log(`  skills out: ${skillsDir}`);
    log(`  roles out: ${rolesDir}`);
    const drifted = [...a.drifted, ...s.drifted, ...r.drifted];
    const orphaned = [...a.orphaned, ...s.orphaned, ...r.orphaned];
    if (a.clean && s.clean && r.clean) {
      log('  OK clean — no drift');
      return;
    }
    if (drifted.length) {
      log('');
      log('  drifted:');
      for (const d of drifted) log(`    ${d.reason.padEnd(9)} ${d.key}`);
    }
    if (orphaned.length) {
      log('');
      log('  orphaned (source removed, output would be pruned):');
      for (const o of orphaned) log(`    orphan    ${o.key}`);
    }
    process.exit(1);
  }

  const ra = compiler.render({ target: 'opencode', outDir: agentDir, items: agentItems, packageVersion, force });
  const rs = compiler.render({ target: 'opencode', outDir: skillsDir, items: skillItems, packageVersion, force });
  const rr = compiler.render({ target: 'opencode', outDir: rolesDir, items: roleItems, packageVersion, force });
  log(`  agents out: ${agentDir}`);
  log(`    written: ${ra.written.length}, unchanged: ${ra.unchanged.length}, pruned: ${ra.pruned.length}, tampered: ${ra.tampered.length}`);
  log(`  skills out: ${skillsDir}`);
  log(`    written: ${rs.written.length}, unchanged: ${rs.unchanged.length}, pruned: ${rs.pruned.length}, tampered: ${rs.tampered.length}`);
  log(`  roles out: ${rolesDir}`);
  log(`    written: ${rr.written.length}, unchanged: ${rr.unchanged.length}, pruned: ${rr.pruned.length}, tampered: ${rr.tampered.length}`);

  const tampered = [...ra.tampered, ...rs.tampered, ...rr.tampered];
  if (tampered.length) {
    log('');
    err('  TAMPER — refused to overwrite (hand-edited outside sync); re-run with --force:');
    for (const t of tampered) err(`    ${t.outputRelPath}`);
    process.exit(1);
  }

  // Managed opencode.jsonc merge (mcp.golem + skills.paths), guarded by a real
  // `opencode debug config` validation with backup/restore on failure.
  const bin = resolveOpencodeBin();
  const validate = makeOpencodeValidator(bin);
  const merge = ocAdapter.buildConfigMerge({ repoRoot: GOLEM_ROOT });
  const configPath = ocAdapter.opencodeConfigPath();
  const res = ocAdapter.applyConfigMerge({ configPath, merge, validate });
  log('');
  log(`  config: ${configPath}`);
  if (!bin) {
    log('    · opencode binary not found — merged config written but NOT validated (install opencode to validate).');
  }
  if (res.restored) {
    err('    FAIL merged config failed `opencode debug config` — restored the previous file:');
    err(indent(res.error, '      '));
    process.exit(1);
  }
  log(res.changed ? '    OK merged mcp.golem + skills.paths + plugin (managed keys only)' : '    OK already up to date (no change)');

  // Pin the opencode version this render was validated against (doctor warns on
  // skew). Only after a clean validated sync.
  if (bin && validate) {
    const ver = opencodeVersion(bin);
    if (ver) {
      const cfg = loadConfig();
      cfg.harnesses = cfg.harnesses ?? {};
      cfg.harnesses.opencode = { ...cfg.harnesses.opencode, testedVersion: ver };
      saveConfig(cfg);
      log(`    pinned harnesses.opencode.testedVersion = ${ver}`);
    }
  }
}

function indent(text, pad) {
  return String(text || '').split('\n').map((l) => pad + l).join('\n');
}

async function cmdDoctor() {
  let failures = 0;
  function ok(label) { log(`  OK ${label}`); }
  function fail(label) { err(`  FAIL ${label}`); failures += 1; }
  function skip(label) { log(`  · ${label}`); }

  log('');
  log('golem doctor');

  log('');
  log('Tooling');
  (await hasCommand('node')) ? ok('node on PATH') : fail('node on PATH');
  (await hasCommand('npm')) ? ok('npm on PATH') : fail('npm on PATH');

  log('');
  log('Dashboard');
  existsSync(DASHBOARD_DIR) ? ok(`dashboard dir exists (${DASHBOARD_DIR})`) : fail('dashboard dir exists');
  existsSync(resolve(GOLEM_ROOT, 'node_modules')) ? ok('root node_modules') : fail('root node_modules — npm install (from the repo root)');
  try {
    await import('better-sqlite3');
    ok('better-sqlite3 loads from root node_modules');
  } catch (e) {
    fail(`better-sqlite3 failed to load — ${e.message}`);
  }

  log('');
  log('Workspace (~/.golem)');
  const legacy = legacyConfigDir();
  const migrated = migratedHomeDir();
  const legacyStat = existsSync(legacy) ? lstatSync(legacy) : null;
  if (existsSync(migrated)) {
    ok(`~/.golem exists (${migrated})`);
    if (legacyStat && legacyStat.isSymbolicLink()) {
      ok(`${legacy} is a compat symlink -> ${readlinkSync(legacy)}`);
    } else if (legacyStat && legacyStat.isDirectory()) {
      fail(`split-brain: ~/.golem exists AND ${legacy} is still a real directory (not a symlink) — a migration was interrupted or something recreated the old dir`);
    } else {
      skip(`${legacy} does not exist — nothing points at it`);
    }
  } else {
    skip(`not yet migrated — run \`golem migrate-home\` to move off ${legacy}`);
  }
  const dbPath = trackerDbPath();
  existsSync(dbPath) ? ok(`tracker DB readable (${dbPath})`) : fail(`tracker DB missing at ${dbPath}`);

  log('');
  log('Substrate sync');
  try {
    const items = planForTarget('cc');
    const outDir = renderDirFor('cc');
    const { clean, drifted, orphaned } = compiler.checkDrift({ target: 'cc', outDir, items });
    clean ? ok(`cc render clean (${outDir})`) : skip(`cc render drifted (${drifted.length} changed, ${orphaned.length} orphaned) — run \`golem sync --target cc\``);
  } catch (e) {
    skip(`could not check substrate drift — ${e.message}`);
  }

  try {
    const projects = knownProjects();
    const root = substrateRoot();
    let driftedProjects = 0;
    for (const p of projects) {
      const projectId = p.id || projectIdFor(p.path);
      const cc = compiler.checkDrift({ target: 'cc', outDir: p.path, items: ccAdapter.buildProjectPlan({ substrateRoot: root }), projectId });
      let clean = cc.clean;
      if (isHarnessEnabled('opencode')) {
        const a = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.projectAgentOutDir(p.path), items: ocAdapter.buildProjectAgentPlan({ substrateRoot: root }), projectId });
        const s = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(p.path), items: ocAdapter.buildProjectSkillPlan({ substrateRoot: root }), projectId });
        clean = clean && a.clean && s.clean;
      }
      if (!clean) driftedProjects += 1;
    }
    driftedProjects === 0
      ? ok(`project renders clean (${projects.length} registered projects checked)`)
      : skip(`project renders drifted in ${driftedProjects}/${projects.length} projects — run \`golem sync --check\` for details`);
  } catch (e) {
    skip(`could not check project render drift — ${e.message}`);
  }

  log('');
  log('opencode harness');
  if (!isHarnessEnabled('opencode')) {
    skip('disabled in ~/.golem/config.json (harnesses.opencode.enabled = false) — not rendered');
  } else {
    try {
      const substrateRoot = resolve(GOLEM_ROOT, 'substrate');
      const a = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.agentOutDir(), items: ocAdapter.buildAgentPlan({ substrateRoot }) });
      const s = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: ocAdapter.buildSkillPlan({ substrateRoot }) });
      const r = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.rolesOutDir(), items: ocAdapter.buildRolePlan({ substrateRoot }) });
      (a.clean && s.clean && r.clean)
        ? ok('opencode render clean (agents + skills + roles)')
        : skip(`opencode render drifted (${a.drifted.length + s.drifted.length + r.drifted.length} changed, ${a.orphaned.length + s.orphaned.length + r.orphaned.length} orphaned) — run \`golem sync --target opencode\``);
    } catch (e) {
      skip(`could not check opencode drift — ${e.message}`);
    }
    // Runtime shim (P5): the file opencode's plugin[] entry points at must exist.
    const shimPath = resolve(GOLEM_ROOT, 'shims', 'opencode', 'index.js');
    existsSync(shimPath) ? ok(`opencode runtime shim present (${shimPath})`) : fail(`opencode runtime shim missing at ${shimPath} — plugin[] would fail to load`);

    const bin = resolveOpencodeBin();
    const actual = opencodeVersion(bin);
    const pinned = loadConfig().harnesses?.opencode?.testedVersion ?? null;
    if (!bin) {
      skip('opencode binary not found on PATH or ~/.opencode/bin — cannot check version skew');
    } else if (pinned && actual && pinned !== actual) {
      skip(`opencode version skew: rendered against ${pinned}, installed is ${actual} — re-run \`golem sync --target opencode\``);
    } else if (actual) {
      ok(`opencode ${actual}${pinned ? ' (matches pinned render)' : ' (no pinned version yet)'}`);
    }
  }

  log('');
  log('LSP capability');
  try {
    const projects = knownProjects();
    if (!projects.length) {
      skip('no registered projects to check');
    }
    for (const p of projects) {
      try {
        const { projectId, lsp } = await updateProjectLsp(p.path);
        const label = p.name || projectId;
        if (lsp.available) ok(`${label}: ${lsp.servers.join(', ')}`);
        else skip(`${label}: none detected`);
      } catch (e) {
        skip(`${p.name || p.id || p.path}: could not check LSP — ${e.message}`);
      }
    }
  } catch (e) {
    skip(`could not record LSP capability — ${e.message}`);
  }

  log('');
  log('Dashboard server reachability');
  const probe = await probeDashboard();
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    ok(`dashboard responding on ${DASHBOARD_URL} (${pc} projects)`);
  } else {
    skip(`dashboard not reachable (${probe.error}) — run \`golem dashboard\` to start`);
  }

  log('');
  if (failures === 0) {
    ok('all critical checks passed');
  } else {
    fail(`${failures} critical check(s) failed`);
    process.exit(1);
  }
}

function cmdHelp() {
  log(`golem — minimal Node CLI for the v4 harness.

Usage:
  npx golem <command> [args]
  node cli/golem.js <command> [args]

Run:
  dashboard [--public] [npm-start-args…]
                       Start the admin dashboard on ${DASHBOARD_URL}.
                       --public binds 0.0.0.0 (LAN-reachable, no auth).
  dashboard:restart [--public] [npm-start-args…]
                       Stop the running dashboard and restart it detached.
  role <role|clear> [--session <id-or-name>]
                        Set or clear a session role (${SESSION_ROLES.join(', ')}).
  migrate-home         One-time move of ~/.config/golem -> ~/.golem (ADR-4).
                       Backs up first, stops the dashboard, moves, symlinks
                       the old path to the new one, restarts. Explicit only —
                       never runs automatically. Rollback is one command
                       (printed on completion).
  sync [--check] [--target cc|cc-marketplace|opencode] [--out <dir>] [--force]
       [--project <root>] [--harness cc|claudecode|opencode]
                        Render substrate/ sources into a harness bundle
                        (default target: cc, default out: ~/.golem/renders/
                        cc-plugin/). --check reports drift without writing
                        (exit 0 clean, 1 drifted). --force overwrites a
                        hand-edited (tampered) output; without it, sync warns
                        and refuses that one file.
                        --project switches to project-scoped artifacts only,
                        rendering into the project root's harness-local dirs and
                        recording the lockfile under projects.<project_id>.
                        With only --check and no target/project args, reports
                        global renders plus all known project render sections.
                       target opencode renders agents into
                       ~/.config/opencode/agent/ + skills into
                       ~/.golem/renders/opencode/skills/ and merges managed
                       keys into opencode.jsonc — only when the opencode
                       harness is enabled in ~/.golem/config.json.

Inspect:
  doctor               Sanity-check the environment.
  status [--json]    Dashboard health + canonical URL.
  help                 Show this message.

Removed in v4 (no longer supported):
  install, cleanup, reinstall, session, project, dispatch, ack

Environment:
  GOLEM_ROOT           Workspace anchor (default: repo containing cli/golem.js).

Install:
  npm link             Symlinks ./cli/golem.js as a global \`golem\` command.
  npx golem <cmd>      Run without installing, from the repo root.
`);
}

function cmdRemoved(name) {
  fatal(2, `Error: \`${name}\` is a v3 subcommand that has been removed in golem v4.\n\nRun \`golem help\` for the surviving commands.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';
  const rest = args.slice(1);

  if (removed.has(cmd)) {
    cmdRemoved(cmd);
    return;
  }

  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      cmdHelp();
      break;
    case 'status':
      await cmdStatus(rest);
      break;
    case 'dashboard':
      await cmdDashboard(rest);
      break;
    case 'dashboard:restart':
      await cmdDashboardRestart(rest);
      break;
    case 'role':
      await cmdRole(rest);
      break;
    case 'migrate-home':
      await cmdMigrateHome(rest);
      break;
    case 'sync':
      await cmdSync(rest);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      fatal(2, `Unknown command: ${cmd}\n\nRun \`golem help\` for available commands.`);
  }
}

main().catch((e) => fatal(1, e.stack || e.message));
