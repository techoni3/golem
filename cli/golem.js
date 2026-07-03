#!/usr/bin/env node
// golem — minimal Node CLI for the v4 harness.
//
// v3 subcommands removed:
//   install, cleanup, reinstall, session, project, dispatch, ack
//
// Surviving subcommands:
//   dashboard    Start the admin dashboard (node dashboard/server/index.js).
//   doctor       Sanity-check the environment.
//   status       Dashboard health + canonical URL.
//   help         Show this message.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { golemHome, legacyConfigDir, migratedHomeDir, trackerDbPath } from '../lib/golem-home.js';

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
async function startDashboardDetached() {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: GOLEM_ROOT,
    stdio: 'ignore',
    detached: true,
    env: process.env,
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
  migrate-home         One-time move of ~/.config/golem -> ~/.golem (ADR-4).
                       Backs up first, stops the dashboard, moves, symlinks
                       the old path to the new one, restarts. Explicit only —
                       never runs automatically. Rollback is one command
                       (printed on completion).

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
    case 'migrate-home':
      await cmdMigrateHome(rest);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      fatal(2, `Unknown command: ${cmd}\n\nRun \`golem help\` for available commands.`);
  }
}

main().catch((e) => fatal(1, e.stack || e.message));
