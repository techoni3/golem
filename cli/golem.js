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
//   codex-supervisor
//                Run one managed, headless Codex App Server lifecycle process.
//   codex        Open one managed interactive Codex TUI.
//   doctor       Sanity-check the environment.
//   status       Dashboard health + canonical URL.
//   help         Show this message.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { golemHome, legacyConfigDir, migratedHomeDir, trackerDbPath, renderDirFor, projectsJsonPath, sessionsJsonPath } from '../lib/golem-home.js';
import { projectIdFor } from '../lib/project-id.js';
import { SESSION_ROLES, pushRoleBriefDirect, setSessionRole } from '../lib/session-role.js';
import { updateProjectLsp } from '../lib/lsp.js';
import { lintSubstrate, formatLintResult } from '../lib/substrate-lint.js';
import * as compiler from '../lib/compiler/engine.js';
import * as ccAdapter from '../lib/compiler/adapters/cc.js';
import * as ocAdapter from '../lib/compiler/adapters/opencode.js';
import * as codexAdapter from '../lib/compiler/adapters/codex.js';
import * as piAdapter from '../lib/compiler/adapters/pi.js';
import { isHarnessEnabled, loadConfig, saveConfig } from '../lib/golem-config.js';
import { CodexSupervisor, readCodexSupervisor } from '../lib/codex-supervisor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLEM_ROOT = resolve(__dirname, '..');
const DASHBOARD_DIR = resolve(GOLEM_ROOT, 'dashboard');
const DEFAULT_DASHBOARD_PORT = 7420;

function dashboardUrl() {
  if (process.env.GOLEM_DASHBOARD_URL) return process.env.GOLEM_DASHBOARD_URL.replace(/\/$/, '');
  const port = process.env.PORT || String(DEFAULT_DASHBOARD_PORT);
  return port === String(DEFAULT_DASHBOARD_PORT)
    ? 'http://dashboard.golem.localhost:7420'
    : `http://127.0.0.1:${port}`;
}

function healthUrl() {
  return `${dashboardUrl()}/api/health`;
}

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
    return { ok: true, data: await httpGetJson(healthUrl()) };
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
      dashboard_url: probe.ok ? dashboardUrl() : null,
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
    log(`  OK running on ${dashboardUrl()} (${pc} projects)`);
  } else {
    log(`  not reachable (${probe.error})`);
    log(`  start it with: golem dashboard`);
  }
}

function publicSupervisorRecord(record) {
  if (!record) return null;
  const { owner_token: _ownerToken, ...health } = record.health ?? {};
  return { ...record, health };
}

async function cmdCodexSupervisor(args) {
  const [subcommand = 'help', ...rest] = args;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    log(`Usage: golem codex-supervisor run --session <canonical-id> [--cwd <dir>]
       golem codex-supervisor approvals --session <canonical-id> [--id <approval-id>] [--decision approve|decline|cancel]

Runs a Golem-owned, headless Codex App Server supervisor in the foreground.
It is version/schema-gated and exposes typed tracker delivery when its bound
MCP is active and the thread is idle. The approvals command is local-only:
list pending redacted requests, inspect one live request with --id, then make
an explicit one-off decision. Stop a running supervisor with Ctrl-C.`);
    return;
  }
  if (subcommand === 'approvals') {
    let canonicalId = null;
    let approvalId = null;
    let decision = null;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === '--session') canonicalId = rest[++index] ?? null;
      else if (arg.startsWith('--session=')) canonicalId = arg.slice('--session='.length);
      else if (arg === '--id') approvalId = rest[++index] ?? null;
      else if (arg.startsWith('--id=')) approvalId = arg.slice('--id='.length);
      else if (arg === '--decision') decision = rest[++index] ?? null;
      else if (arg.startsWith('--decision=')) decision = arg.slice('--decision='.length);
      else fatal(2, `unknown codex-supervisor approvals option: ${arg}`);
    }
    if (!canonicalId) fatal(2, 'codex-supervisor approvals requires --session <canonical-id>');
    if (decision && !approvalId) fatal(2, 'codex-supervisor approvals --decision requires --id <approval-id>');
    if (decision && !['approve', 'decline', 'cancel'].includes(decision)) fatal(2, 'approval decision must be approve, decline, or cancel');
    const record = readCodexSupervisor(canonicalId);
    if (!record?.health?.owner_token || !record.health.host || !record.health.port) {
      fatal(1, `managed Codex supervisor ${canonicalId} has no live owner-authenticated loopback endpoint`);
    }
    if (!['127.0.0.1', '::1', 'localhost'].includes(record.health.host)) {
      fatal(1, 'refusing approval operation: supervisor endpoint is not loopback');
    }
    const suffix = approvalId
      ? `/approvals/${encodeURIComponent(approvalId)}${decision ? '/decision' : ''}`
      : '/approvals';
    const response = await fetch(`http://${record.health.host}:${record.health.port}${suffix}`, {
      method: decision ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'x-golem-target-session': canonicalId,
        'x-golem-endpoint-owner': record.health.owner_token,
      },
      body: decision ? JSON.stringify({ decision }) : undefined,
    });
    const text = await response.text();
    if (!response.ok) fatal(1, `approval operation failed (${response.status}): ${text}`);
    log(text || '{}');
    return;
  }
  if (subcommand !== 'run') fatal(2, `Unknown codex-supervisor command: ${subcommand}`);
  let canonicalId = null;
  let cwd = process.cwd();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--session') canonicalId = rest[++index] ?? null;
    else if (arg.startsWith('--session=')) canonicalId = arg.slice('--session='.length);
    else if (arg === '--cwd') cwd = rest[++index] ?? null;
    else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
    else fatal(2, `unknown codex-supervisor option: ${arg}`);
  }
  if (!canonicalId) fatal(2, 'codex-supervisor run requires --session <canonical-id>');
  if (!cwd) fatal(2, 'codex-supervisor run requires a non-empty --cwd');
  const supervisor = new CodexSupervisor({ canonicalId, cwd });
  const record = await supervisor.start();
  log(JSON.stringify({ ok: true, supervisor: publicSupervisorRecord(record) }, null, 2));
  let unexpectedExit = null;
  await new Promise((resolve) => {
    const stop = () => resolve();
    supervisor.once('dead', ({ error }) => { unexpectedExit = error; resolve(); });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await supervisor.stop();
  if (unexpectedExit) throw unexpectedExit;
}

function codexTuiHelp() {
  log(`Usage: golem codex [--session <canonical-id>] [--cwd <dir>] [-- <codex args...>]

Open a normal interactive Codex TUI backed by one Golem-owned, private App
Server. With no flags it uses the current directory and creates one canonical
tracker session. The TUI owns normal Codex model, sandbox, and approval options.

Wrapper options:
  --session <canonical-id>  Reuse a chosen tracker canonical id.
  --cwd <dir>               Run the App Server and TUI in this directory.

All other Codex arguments are passed through. --remote and -C/--cd are
reserved: Golem owns the private Unix socket and canonical project directory.
When an explicit --session has a stored thread, Golem launches native
\`codex resume <thread-id>\` through that same private bridge.`);
}

function isReservedCodexTuiArgument(arg) {
  return arg === '--remote' || arg.startsWith('--remote=')
    || arg === '--remote-auth-token-env' || arg.startsWith('--remote-auth-token-env=')
    || arg === '--cd' || arg.startsWith('--cd=')
    || arg === '-C' || arg.startsWith('-C=') || (arg.startsWith('-C') && arg.length > 2);
}

function reservedCodexTuiArgumentMessage(arg) {
  if (arg === '--remote' || arg.startsWith('--remote=')) {
    return 'golem codex owns --remote; remove it and let Golem create the private Unix socket';
  }
  if (arg === '--remote-auth-token-env' || arg.startsWith('--remote-auth-token-env=')) {
    return 'golem codex uses a private Unix socket and does not accept remote authentication options';
  }
  return 'golem codex owns the working directory; use wrapper --cwd before -- and do not pass -C/--cd';
}

async function cmdCodex(args) {
  if (args.includes('--help') || args.includes('-h')) {
    codexTuiHelp();
    return;
  }
  let canonicalId = null;
  let cwd = process.cwd();
  const passthrough = [];
  let passthroughOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      passthroughOnly = true;
      continue;
    }
    if (isReservedCodexTuiArgument(arg)) fatal(2, reservedCodexTuiArgumentMessage(arg));
    if (passthroughOnly) {
      passthrough.push(arg);
      continue;
    }
    if (arg === '--session') canonicalId = args[++index] ?? null;
    else if (arg.startsWith('--session=')) canonicalId = arg.slice('--session='.length);
    else if (arg === '--cwd') cwd = args[++index] ?? null;
    else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
    else passthrough.push(arg);
  }
  if (!cwd) fatal(2, 'golem codex requires a non-empty --cwd');
  if (canonicalId != null && !canonicalId.trim()) fatal(2, 'golem codex requires a non-empty --session');

  const supervisor = new CodexSupervisor({
    ...(canonicalId ? { canonicalId: canonicalId.trim() } : {}),
    cwd,
    mode: 'tui',
  });
  await supervisor.start();
  const remote = supervisor.tuiBridge?.remoteUrl;
  if (!remote) {
    await supervisor.stop().catch(() => {});
    throw new Error('managed Codex TUI bridge did not expose a private Unix socket');
  }

  // OpenAI documents remote mode for `codex resume`. When a caller names the
  // same canonical session again, use that native lifecycle rather than
  // starting a fresh thread and silently overwriting the durable mapping.
  const resumeThreadId = canonicalId ? supervisor.threadId : null;
  const launchArgs = ['--remote', remote];
  if (resumeThreadId) launchArgs.push('resume', resumeThreadId);
  launchArgs.push(...passthrough);
  const tui = spawn('codex', launchArgs, {
    cwd: supervisor.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await supervisor.stop().catch((error) => err(`golem codex cleanup failed: ${error.message}`));
  };
  const onSigint = () => {
    // SIGINT is intentionally for the foreground TUI's active turn. Terminal
    // delivery reaches that child too; do not stop the bridge merely because a
    // human interrupted generation. TUI exit remains the cleanup boundary.
  };
  const onSigterm = () => {
    if (tui.exitCode === null) tui.kill('SIGTERM');
    void stop();
  };
  process.on('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let exitCode = 0;
  try {
    await new Promise((resolve) => {
      tui.once('error', (error) => {
        err(`golem codex could not start the TUI: ${error.message}`);
        exitCode = 1;
        resolve();
      });
      tui.once('exit', (code) => {
        exitCode = Number.isInteger(code) ? code : 1;
        resolve();
      });
      supervisor.once('dead', () => {
        if (tui.exitCode === null) tui.kill('SIGTERM');
        exitCode = exitCode || 1;
        resolve();
      });
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await stop();
  }
  if (exitCode) process.exitCode = exitCode;
}

function readSessionsRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(sessionsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function readSessionsRegistryObject(file = sessionsJsonPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.sessions) ? parsed : { version: 1, sessions: [] };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeSessionsRegistryObject(file, reg) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, file);
}

function withFileLock(lockPath, fn) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockPath);
      try { return fn(); }
      finally { try { rmdirSync(lockPath); } catch { /* ignore */ } }
    } catch (e) {
      if (e?.code === 'EEXIST') {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > 5000) rmdirSync(lockPath);
        } catch { /* ignore */ }
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* brief spin */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`failed to acquire ${lockPath}`);
}

function rowTime(row, keys) {
  for (const key of keys) {
    const t = Date.parse(row?.[key] || '');
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function isLiveSessionRow(row) {
  return !row?.ended_at;
}

function rowFreshness(row, alive) {
  return alive
    ? rowTime(row, ['updated_at', 'last_seen_at', 'boot_time', 'started_at'])
    : rowTime(row, ['ended_at', 'updated_at', 'last_seen_at', 'boot_time', 'started_at']);
}

function sessionLabel(row) {
  return `${row.session_id || '(no session_id)'}${row.model ? ` (model=${row.model})` : ''}`;
}

function keptSessionLabel(row, reason) {
  return `${row.session_id || '(no session_id)'} (${reason}${row.model ? `, model=${row.model}` : ''})`;
}

function sessionsDedupPlan(sessions) {
  const groups = new Map();
  sessions.forEach((row, index) => {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ row, index });
  });

  const plans = [];
  for (const [name, rows] of groups) {
    if (rows.length < 2) continue;
    const live = rows.filter(({ row }) => isLiveSessionRow(row));
    const candidates = live.length ? live : rows;
    const keep = candidates
      .slice()
      .sort((a, b) => rowFreshness(b.row, live.length > 0) - rowFreshness(a.row, live.length > 0))[0];
    const mark = rows.filter((entry) => entry.index !== keep.index && !entry.row.ended_at);
    plans.push({ name, keep, mark, liveKept: live.length > 0 });
  }
  return plans;
}

function printSessionsDedupPlan(plans, apply) {
  if (!plans.length) {
    log(`golem sessions dedup: no named duplicate sessions found (${apply ? 'applied' : 'dry-run'})`);
    return;
  }
  log(`golem sessions dedup ${apply ? '--apply' : '(dry-run; pass --apply to write)'}`);
  for (const plan of plans) {
    const reason = plan.liveKept ? 'freshest live' : 'freshest ended';
    log(`name ${plan.name}: would keep ${keptSessionLabel(plan.keep.row, reason)}`);
    if (plan.mark.length) {
      log(`name ${plan.name}: would mark ended: ${plan.mark.map(({ row }) => sessionLabel(row)).join(', ')}`);
    } else {
      log(`name ${plan.name}: no un-ended duplicates to mark`);
    }
  }
}

async function cmdSessions(args) {
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help') {
    log(`Usage: golem sessions dedup [--apply]

Commands:
  dedup          Dry-run named-session duplicate cleanup.

Options:
  --apply        Write the cleanup. Without --apply, prints the plan only.
  -h, --help     Show help.`);
    return;
  }
  if (sub !== 'dedup') fatal(2, `Unknown sessions command: ${sub}\n\nRun \`golem sessions --help\`.`);
  const rest = args.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) {
    log(`Usage: golem sessions dedup [--apply]

Dry-run by default. Groups rows in ~/.golem/sessions.json by non-empty name,
keeps the freshest live row for each name, and with --apply marks the other
un-ended rows ended_at=<now>. Unnamed rows are never touched.`);
    return;
  }
  const unknown = rest.filter((a) => a !== '--apply');
  if (unknown.length) fatal(2, `unknown sessions dedup option: ${unknown[0]}`);

  const apply = rest.includes('--apply');
  const file = sessionsJsonPath();
  const run = () => {
    const reg = readSessionsRegistryObject(file);
    const plans = sessionsDedupPlan(reg.sessions);
    printSessionsDedupPlan(plans, apply);
    if (!apply) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const plan of plans) {
      for (const { index } of plan.mark) {
        if (reg.sessions[index]?.ended_at) continue;
        reg.sessions[index] = { ...reg.sessions[index], ended_at: now };
        changed = true;
      }
    }
    if (changed) writeSessionsRegistryObject(file, reg);
    log(changed ? `applied: marked duplicate sessions ended_at=${now}` : 'applied: no changes');
  };
  if (apply) withFileLock(`${file}.lock`, run);
  else run();
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
  if (roleArg === 'list' || roleArg === '--list') {
    log(SESSION_ROLES.join('\n'));
    return;
  }
  if (!roleArg || roleArg === '-h' || roleArg === '--help') {
    log(`Usage: golem role <${SESSION_ROLES.join('|')}|clear> [--session <id-or-name>]\n       golem role list`);
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
  const activation = role ? await pushRoleBriefDirect(updated.session_id, role, updated) : null;
  log(JSON.stringify({
    ok: true,
    session_id: updated.session_id,
    name: updated.name ?? null,
    role: updated.role,
    role_updated_at: updated.role_updated_at,
    role_updated_by: updated.role_updated_by,
    activation,
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

function dashboardLogPath() {
  const dir = join(golemHome(), 'logs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `dashboard-${stamp}.log`);
}

function tailFile(file, maxLines = 20) {
  try {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
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
  const logFile = dashboardLogPath();
  const outFd = openSync(logFile, 'a');
  const errFd = openSync(logFile, 'a');
  let exitInfo = null;
  const child = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: GOLEM_ROOT,
    stdio: ['ignore', outFd, errFd],
    detached: true,
    env,
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  child.on('error', (e) => {
    exitInfo = { error: e.message };
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  const deadline = Date.now() + Number(process.env.GOLEM_DASHBOARD_STARTUP_TIMEOUT_MS || 20000);
  while (Date.now() < deadline) {
    const probe = await probeDashboard();
    if (probe.ok) return { ok: true, logFile, pid: child.pid };
    if (exitInfo) break;
    await sleep(300);
  }
  return { ok: false, logFile, pid: child.pid, exit: exitInfo, tail: tailFile(logFile) };
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
  log(`  log: ${started.logFile}`);
  if (!started.ok) {
    const exit = started.exit
      ? started.exit.error
        ? `; child error: ${started.exit.error}`
        : `; child exit code=${started.exit.code ?? 'null'} signal=${started.exit.signal ?? 'null'}`
      : '';
    const tail = started.tail ? `\n\nLast log lines:\n${started.tail}` : '';
    fatal(1, `  FAIL dashboard did not come back up within startup window${exit}. Log: ${started.logFile}${tail}`);
  }
  log(`  OK dashboard responding on ${dashboardUrl()} (pid=${started.pid})`);
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
  log(`  log: ${up.logFile}`);
  if (up.ok) {
    log('  OK dashboard responding');
  } else {
    const exit = up.exit
      ? up.exit.error
        ? `; child error: ${up.exit.error}`
        : `; child exit code=${up.exit.code ?? 'null'} signal=${up.exit.signal ?? 'null'}`
      : '';
    err(`  FAIL dashboard did not come back up within startup window${exit}. Log: ${up.logFile}`);
    if (up.tail) err(`\nLast log lines:\n${up.tail}`);
  }

  log('');
  log('Rollback (one operation): ');
  log(`  rm "${src}" && mv "${dest}" "${src}" && golem dashboard`);
  log(`  (or restore from backup: tar -xzf ${backupPath} -C ${home})`);
}

const ADAPTERS = { cc: ccAdapter, codex: codexAdapter, pi: piAdapter };
const KNOWN_TARGETS = ['cc', 'cc-marketplace', 'opencode', 'codex', 'pi'];

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
  if (KNOWN_TARGETS.includes(target)) return target;
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

function printTamper({ tampered, forceHint = '--force' }) {
  if (!tampered.length) return;
  log('');
  err(`  TAMPER — refused to overwrite; re-run with ${forceHint} to replace the managed region:`);
  for (const t of tampered) {
    const region = t.block ? ' (golem:instructions block)' : '';
    const why = t.reason ? ` — ${t.reason}` : '';
    err(`    ${t.outputRelPath}${region}${why}`);
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
  const all = args.includes('--all');
  const force = args.includes('--force');
  const explicitTarget = optionValue(args, '--target') || optionValue(args, '--harness');
  const target = normalizeTarget(explicitTarget || 'cc');
  const projectArg = optionValue(args, '--project');

  if (checkOnly && (all || (!explicitTarget && !projectArg && !optionValue(args, '--out') && args.filter((a) => a !== '--check').length === 0))) {
    return cmdSyncCheckAll();
  }

  const lint = lintSubstrate({ substrateRoot: substrateRoot() });
  if (lint.warnings.length) err(formatLintResult({ warnings: lint.warnings }));
  if (!lint.ok) fatal(1, formatLintResult(lint));

  if (projectArg) {
    if (target === 'cc-marketplace') fatal(2, '--project is not valid with cc-marketplace');
    return cmdSyncProject({ target, projectRoot: resolve(projectArg), checkOnly, force });
  }

  if (target === 'opencode') {
    return cmdSyncOpencode({ checkOnly, force });
  }

  const customOut = optionValue(args, '--out');
  const outDir = customOut ? resolve(customOut) : renderDirFor(target);

  const items = planForTarget(target);
  const instructionItems = target === 'cc' && !customOut ? ccAdapter.buildInstructionPlan({ substrateRoot: substrateRoot() }) : [];
  const instructionOutDir = ccAdapter.instructionOutDir();

  if (checkOnly) {
    const main = compiler.checkDrift({ target, outDir, items });
    const instr = instructionItems.length
      ? compiler.checkDrift({ target: 'cc-instructions', outDir: instructionOutDir, items: instructionItems })
      : { clean: true, drifted: [], orphaned: [] };
    const clean = main.clean && instr.clean;
    log('');
    log(`golem sync --check --target ${target}`);
    log(`  out: ${outDir}`);
    if (instructionItems.length) log(`  instructions out: ${instructionOutDir}`);
    printDrift({ clean, drifted: [...main.drifted, ...instr.drifted], orphaned: [...main.orphaned, ...instr.orphaned] });
    if (!clean) process.exit(1);
    return;
  }

  const main = compiler.render({
    target,
    outDir,
    items,
    packageVersion: readPackageVersion(),
    force,
  });
  const instr = instructionItems.length
    ? compiler.render({ target: 'cc-instructions', outDir: instructionOutDir, items: instructionItems, packageVersion: readPackageVersion(), force })
    : { written: [], unchanged: [], tampered: [], pruned: [] };
  if (target === 'cc') {
    ccAdapter.syncMcpChannelDeps({ repoRoot: GOLEM_ROOT, outDir });
  }
  if (target === 'codex') {
    ccAdapter.syncMcpChannelDeps({ repoRoot: GOLEM_ROOT, outDir: join(outDir, 'plugins', 'golem') });
  }
  if (target === 'cc-marketplace') {
    ccAdapter.ensureMarketplacePluginLink({ ccPluginDir: renderDirFor('cc'), marketplaceOutDir: outDir });
  }

  log('');
  log(`golem sync --target ${target}`);
  log(`  out: ${outDir}`);
  if (instructionItems.length) log(`  instructions out: ${instructionOutDir}`);
  const written = [...main.written, ...instr.written];
  const unchanged = [...main.unchanged, ...instr.unchanged];
  const tampered = [...main.tampered, ...instr.tampered];
  const pruned = [...main.pruned, ...instr.pruned];
  log(`  written: ${written.length}, unchanged: ${unchanged.length}, pruned: ${pruned.length}, tampered: ${tampered.length}`);
  if (tampered.length) {
    printTamper({ tampered });
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

async function cmdSyncCheckAll({ quiet = false } = {}) {
  let drift = false;
  const say = quiet ? () => {} : log;
  if (!quiet) log('');
  say('golem sync --check --all');

  const lint = lintSubstrate({ substrateRoot: substrateRoot() });
  if (!quiet) log('');
  say('substrate lint:');
  for (const line of formatLintResult(lint).split('\n')) say(`  ${line}`);
  drift = drift || !lint.ok;

  const ccOut = renderDirFor('cc');
  const cc = compiler.checkDrift({ target: 'cc', outDir: ccOut, items: planForTarget('cc') });
  const ccInstrOut = ccAdapter.instructionOutDir();
  const ccInstr = compiler.checkDrift({ target: 'cc-instructions', outDir: ccInstrOut, items: ccAdapter.buildInstructionPlan({ substrateRoot: substrateRoot() }) });
  if (!quiet) log('');
  say(`global cc: ${ccOut}`);
  say(`  instructions out: ${ccInstrOut}`);
  if (!quiet) printDrift({ clean: cc.clean && ccInstr.clean, drifted: [...cc.drifted, ...ccInstr.drifted], orphaned: [...cc.orphaned, ...ccInstr.orphaned] });
  drift = drift || !cc.clean || !ccInstr.clean;

  const marketplaceOut = renderDirFor('cc-marketplace');
  const marketplace = compiler.checkDrift({ target: 'cc-marketplace', outDir: marketplaceOut, items: planForTarget('cc-marketplace') });
  if (!quiet) log('');
  say(`global cc-marketplace: ${marketplaceOut}`);
  if (!quiet) printDrift(marketplace);
  drift = drift || !marketplace.clean;

  const codexOut = renderDirFor('codex');
  const codex = compiler.checkDrift({ target: 'codex', outDir: codexOut, items: planForTarget('codex') });
  if (!quiet) log('');
  say(`global codex: ${codexOut}`);
  if (!quiet) printDrift(codex);
  drift = drift || !codex.clean;

  const piOut = renderDirFor('pi');
  const pi = compiler.checkDrift({ target: 'pi', outDir: piOut, items: planForTarget('pi') });
  if (!quiet) log('');
  say(`global pi: ${piOut}`);
  if (!quiet) printDrift(pi);
  drift = drift || !pi.clean;

  if (isHarnessEnabled('opencode')) {
    const root = substrateRoot();
    const a = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.agentOutDir(), items: ocAdapter.buildAgentPlan({ substrateRoot: root }) });
    const s = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: ocAdapter.buildSkillPlan({ substrateRoot: root }) });
    const i = compiler.checkDrift({ target: 'opencode-instructions', outDir: ocAdapter.instructionOutDir(), items: ocAdapter.buildInstructionPlan({ substrateRoot: root }) });
    const clean = a.clean && s.clean && i.clean;
    if (!quiet) log('');
    say('global opencode:');
    say(`  agents out: ${ocAdapter.agentOutDir()}`);
    say(`  skills out: ${ocAdapter.skillsOutDir()}`);
    say(`  instructions out: ${ocAdapter.instructionOutDir()}`);
    if (!quiet) printDrift({ clean, drifted: [...a.drifted, ...s.drifted, ...i.drifted], orphaned: [...a.orphaned, ...s.orphaned, ...i.orphaned] });
    drift = drift || !clean;
  }

  for (const p of knownProjects()) {
    const projectId = p.id || projectIdFor(p.path);
    const ccProj = compiler.checkDrift({ target: 'cc', outDir: p.path, items: ccAdapter.buildProjectPlan({ substrateRoot: substrateRoot() }), projectId });
    if (!quiet) log('');
    say(`project cc ${projectId}: ${p.path}`);
    if (!quiet) printDrift(ccProj);
    drift = drift || !ccProj.clean;
    if (isHarnessEnabled('opencode')) {
      const root = substrateRoot();
      const a = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.projectAgentOutDir(p.path), items: ocAdapter.buildProjectAgentPlan({ substrateRoot: root }), projectId });
      const s = compiler.checkDrift({ target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(p.path), items: ocAdapter.buildProjectSkillPlan({ substrateRoot: root }), projectId });
      const clean = a.clean && s.clean;
      say(`project opencode ${projectId}: ${p.path}`);
      if (!quiet) printDrift({ clean, drifted: [...a.drifted, ...s.drifted], orphaned: [...a.orphaned, ...s.orphaned] });
      drift = drift || !clean;
    }
  }

  if (drift && !quiet) process.exit(1);
  return !drift;
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
  const instructionItems = ocAdapter.buildInstructionPlan({ substrateRoot: root });
  const agentDir = ocAdapter.agentOutDir();
  const skillsDir = ocAdapter.skillsOutDir();
  const instructionDir = ocAdapter.instructionOutDir();

  if (checkOnly) {
    const a = compiler.checkDrift({ target: 'opencode', outDir: agentDir, items: agentItems });
    const s = compiler.checkDrift({ target: 'opencode', outDir: skillsDir, items: skillItems });
    const i = compiler.checkDrift({ target: 'opencode-instructions', outDir: instructionDir, items: instructionItems });
    log(`  agents out: ${agentDir}`);
    log(`  skills out: ${skillsDir}`);
    log(`  instructions out: ${instructionDir}`);
    const drifted = [...a.drifted, ...s.drifted, ...i.drifted];
    const orphaned = [...a.orphaned, ...s.orphaned, ...i.orphaned];
    if (a.clean && s.clean && i.clean) {
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
  const ri = compiler.render({ target: 'opencode-instructions', outDir: instructionDir, items: instructionItems, packageVersion, force });
  log(`  agents out: ${agentDir}`);
  log(`    written: ${ra.written.length}, unchanged: ${ra.unchanged.length}, pruned: ${ra.pruned.length}, tampered: ${ra.tampered.length}`);
  log(`  skills out: ${skillsDir}`);
  log(`    written: ${rs.written.length}, unchanged: ${rs.unchanged.length}, pruned: ${rs.pruned.length}, tampered: ${rs.tampered.length}`);
  log(`  instructions out: ${instructionDir}`);
  log(`    written: ${ri.written.length}, unchanged: ${ri.unchanged.length}, pruned: ${ri.pruned.length}, tampered: ${ri.tampered.length}`);

  const tampered = [...ra.tampered, ...rs.tampered, ...ri.tampered];
  if (tampered.length) {
    printTamper({ tampered });
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
    const clean = await cmdSyncCheckAll({ quiet: true });
    clean ? ok('sync --check --all clean') : fail('sync --check --all drifted or lint failed — run `golem sync --check --all`');
  } catch (e) {
    fail(`could not run sync --check --all — ${e.message}`);
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
      (a.clean && s.clean)
        ? ok('opencode render clean (agents + skills)')
        : skip(`opencode render drifted (${a.drifted.length + s.drifted.length} changed, ${a.orphaned.length + s.orphaned.length} orphaned) — run \`golem sync --target opencode\``);
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
  log('Worktrees');
  try {
    const projects = knownProjects();
    let worktreeProjects = 0;
    let staleCount = 0;
    for (const p of projects) {
      const wtDir = resolve(p.path, '.worktrees');
      if (!existsSync(wtDir)) continue;
      worktreeProjects++;
      let entries;
      try { entries = readdirSync(wtDir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const wtPath = resolve(wtDir, e.name);
        const gitFile = resolve(wtPath, '.git');
        if (!existsSync(gitFile)) continue;
        // Check staleness: >7 days old
        let stale = false;
        let reason = '';
        try {
          const st = statSync(wtPath);
          const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > 7) { stale = true; reason = `idle ${Math.round(ageDays)}d`; }
        } catch { /* can't stat */ }
        // Check if branch is fully merged into main
        if (!stale) {
          try {
            const gitdirContent = readFileSync(gitFile, 'utf8');
            const m = gitdirContent.match(/^gitdir:\s*(.+)$/m);
            if (m) {
              const branchPath = m[1].trim();
              const branchName = basename(branchPath);
              const r = spawnSync('git', ['branch', '--list', '--merged', 'main', branchName], { cwd: p.path, encoding: 'utf8', timeout: 3000 });
              if (r.status === 0 && r.stdout.trim()) { stale = true; reason = 'merged into main'; }
            }
          } catch { /* can't check merge status */ }
        }
        if (stale) {
          staleCount++;
          log(`  ⚠ ${p.name || p.id}: .worktrees/${e.name} — ${reason}`);
        }
      }
    }
    if (staleCount === 0) {
      worktreeProjects > 0 ? ok(`no stale worktrees (${worktreeProjects} project(s) with .worktrees/)`) : skip('no .worktrees/ dirs found');
    } else {
      skip(`${staleCount} stale worktree(s) found — review and \`git worktree remove\` when done`);
    }
  } catch (e) {
    skip(`could not check worktrees — ${e.message}`);
  }

  log('');
  log('Dashboard server reachability');
  const probe = await probeDashboard();
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    ok(`dashboard responding on ${dashboardUrl()} (${pc} projects)`);
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
                       Start the admin dashboard on ${dashboardUrl()}.
                       --public binds 0.0.0.0 (LAN-reachable, no auth).
  dashboard:restart [--public] [npm-start-args…]
                       Stop the running dashboard and restart it detached.
  codex-supervisor run --session <canonical-id> [--cwd <dir>]
                       Run a version-gated, headless Codex App Server lifecycle
                       supervisor with typed delivery while idle and MCP-bound.
  codex [--session <canonical-id>] [--cwd <dir>] [-- <codex args...>]
                       Open a normal interactive Codex TUI through Golem's
                       private App Server bridge; no flags are required.
  role <role|clear> [--session <id-or-name>]
                         Set or clear a session role (${SESSION_ROLES.join(', ')}).
  sessions dedup [--apply]
                         Dry-run named-session duplicate cleanup; --apply marks
                         stale duplicate rows ended_at under sessions.json.lock.
  migrate-home         One-time move of ~/.config/golem -> ~/.golem (ADR-4).
                       Backs up first, stops the dashboard, moves, symlinks
                       the old path to the new one, restarts. Explicit only —
                       never runs automatically. Rollback is one command
                       (printed on completion).
  sync [--check] [--all] [--target cc|cc-marketplace|opencode] [--out <dir>] [--force]
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
                         With --check --all, or only --check and no target/project args, reports
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
    case 'codex-supervisor':
      await cmdCodexSupervisor(rest);
      break;
    case 'codex':
      await cmdCodex(rest);
      break;
    case 'role':
      await cmdRole(rest);
      break;
    case 'sessions':
      await cmdSessions(rest);
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
