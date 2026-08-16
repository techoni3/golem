import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardJsonPath, projectsJsonPath } from './golem-home.js';
import { resolveGolemDashboardBaseUrl } from './golem-client.js';
import { getRole } from './session-role.js';
import { resolveRoleExecution } from './role-preset.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { markSessionFactsEnded } from './session-facts.js';
import { markSessionsEnded } from './session-registry.js';
import {
  capturePane,
  attachSession,
  killSession,
  newSession,
  panePid,
  hasSession,
  processIdsInGroup,
  terminateProcessGroup,
} from './tmux-driver.js';
import {
  claimWorker,
  findWorker,
  listWorkers,
  updateWorker,
} from './worker-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.resolve(HERE, '..', 'cli', 'golem.js');
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function dashboardBaseUrl() {
  if (process.env.GOLEM_DASHBOARD_URL) return process.env.GOLEM_DASHBOARD_URL.replace(/\/+$/, '');
  return resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() });
}

async function requestJson(pathname, { method = 'GET', body, timeoutMs = 1500 } = {}) {
  const url = new URL(pathname, `${dashboardBaseUrl()}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'X-Sender': 'cli', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      const detail = typeof parsed === 'object' && parsed?.error ? parsed.error : String(parsed || response.statusText);
      throw new Error(`dashboard ${method} ${pathname} → ${response.status} ${detail}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function readKnownProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

async function projectFromInput(input, baseCwd = process.cwd()) {
  if (input == null || input === '') {
    const root = await resolveProjectRoot(baseCwd);
    return { projectRoot: root, projectId: projectIdFor(root) };
  }

  const value = String(input).trim();
  const known = readKnownProjects().find((project) => {
    if (project?.project_id === value || project?.id === value || project?.name === value) return true;
    if (!project?.path) return false;
    try { return projectIdFor(path.resolve(project.path)) === value; } catch { return false; }
  });
  const candidate = known?.path || value;
  try {
    const root = await resolveProjectRoot(path.resolve(baseCwd, candidate));
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    return { projectRoot: root, projectId: projectIdFor(root) };
  } catch {
    throw new Error(`project not found or is not a directory: ${value}`);
  }
}

export async function resolveWorkerProject(input, { cwd = process.cwd() } = {}) {
  return projectFromInput(input, cwd);
}

async function dispatchable(projectId) {
  const query = `?project=${encodeURIComponent(projectId)}`;
  const rows = await requestJson(`/api/sessions/dispatchable${query}`, {
    timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
  });
  if (!Array.isArray(rows)) throw new Error('dashboard dispatchable response was not an array');
  return rows.filter((row) => row?.project_id === projectId);
}

export async function waitForWorkerRegistration({
  projectId,
  name,
  timeoutMs = numberEnv('GOLEM_WORKER_READY_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS),
  pollMs = numberEnv('GOLEM_WORKER_POLL_MS', DEFAULT_POLL_MS),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const rows = await dispatchable(projectId);
      const match = rows.find((row) => row?.harness === 'pi' && row?.name === name && row?.session_id);
      if (match) return match;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  const suffix = lastError ? `; last dashboard error: ${lastError.message}` : '';
  throw new Error(`worker ${name} did not become dispatchable within ${timeoutMs}ms${suffix}`);
}

async function assignRole(sessionId, role) {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/role`, {
    method: 'POST',
    body: { role },
    timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
  });
}

function launcherCommand(role, name) {
  const cli = process.env.GOLEM_WORKER_CLI || DEFAULT_CLI;
  return [process.execPath, cli, 'pi', '--role', role, '--name', name];
}

function markFailed(worker, error) {
  try {
    return updateWorker(worker.worker_id, {
      state: 'failed',
      error: String(error?.message ?? error),
    });
  } catch {
    return worker;
  }
}

/** Spawn one worker through the locked registry → tmux → dispatchable flow. */
export async function spawnWorker({ role, name = null, project = null, cwd = process.cwd() } = {}) {
  const roleRecord = getRole(role);
  if (!roleRecord) throw new Error(`unknown role: ${role}`);
  const projectInfo = await projectFromInput(project, cwd);
  // Resolve through T1. The explicit worker name wins over a role's optional
  // name preset so the tmux identity and Pi display name stay identical.
  const initialPreset = resolveRoleExecution(roleRecord.name);
  const claimed = claimWorker({
    role: roleRecord.name,
    projectId: projectInfo.projectId,
    projectRoot: projectInfo.projectRoot,
    cwd: projectInfo.projectRoot,
    name,
    preset: initialPreset,
  });
  let worker = claimed;
  try {
    worker = updateWorker(claimed.worker_id, {
      // The claimed name is the explicit Pi session name, even when the role
      // preset had its own optional name field.
      preset: resolveRoleExecution(roleRecord.name, { name: claimed.name }),
    });
    if (hasSession(worker.tmux_session)) {
      throw new Error(`tmux session already exists: ${worker.tmux_session}`);
    }
    // Claim is durable before this call. The command is exec'd inside tmux so
    // pane_pid is the golem pi pid and, by contract, also its process group id.
    newSession({
      name: worker.tmux_session,
      cwd: projectInfo.projectRoot,
      command: launcherCommand(roleRecord.name, worker.name),
      width: 200,
      height: 50,
    });
    const pid = panePid(worker.tmux_session);
    worker = updateWorker(worker.worker_id, { pid });
    const registered = await waitForWorkerRegistration({
      projectId: projectInfo.projectId,
      name: worker.name,
    });
    await assignRole(registered.session_id, roleRecord.name);
    worker = updateWorker(worker.worker_id, {
      session_id: registered.session_id,
      state: 'live',
      error: null,
      registered_at: new Date().toISOString(),
      channel_url: registered.channel_url ?? null,
    });
    return workerView(worker, registered);
  } catch (error) {
    markFailed(worker, error);
    throw error;
  }
}

function reconcileWorker(worker) {
  if (!['spawning', 'live', 'failed'].includes(String(worker.state || '').toLowerCase())) return worker;
  let alive = false;
  try {
    alive = worker.pid ? processIdsInGroup(worker.pid).length > 0 : hasSession(worker.tmux_session);
  } catch {
    alive = true;
  }
  if (alive) return worker;
  try {
    const dead = updateWorker(worker.worker_id, {
      state: 'dead',
      ended_at: new Date().toISOString(),
    });
    if (worker.session_id) {
      try { markSessionFactsEnded([worker.session_id], { status: 'stopped' }); } catch {}
      try { markSessionsEnded([worker.session_id], { status: 'stopped' }); } catch {}
    }
    return dead;
  } catch {
    return worker;
  }
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function idleSeconds(worker, roster = null) {
  const started = timestampMs(roster?.status === 'idle' ? (roster.updated_at ?? worker.spawned_at) : worker.spawned_at);
  return started == null ? null : Math.max(0, Math.floor((Date.now() - started) / 1000));
}

function workerView(worker, roster = null) {
  const idle = idleSeconds(worker, roster);
  return {
    ...worker,
    model: worker.preset?.model ?? null,
    provider: worker.preset?.provider ?? null,
    harness: worker.preset?.harness ?? 'pi',
    status: worker.state === 'live' ? (roster?.status ?? worker.state) : worker.state,
    dispatchable: worker.state === 'live' && !!roster,
    idle_seconds: idle,
    attach_hint: `golem attach ${worker.name}`,
  };
}

export async function listWorkerViews({ project = null, cwd = process.cwd() } = {}) {
  const projectInfo = project == null ? null : await projectFromInput(project, cwd);
  const rows = listWorkers({ projectId: projectInfo?.projectId ?? null }).map(reconcileWorker);
  let roster = [];
  try {
    roster = projectInfo ? await dispatchable(projectInfo.projectId) : await requestJson('/api/sessions/dispatchable', {
      timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
    });
    if (!Array.isArray(roster)) roster = [];
  } catch {
    roster = [];
  }
  const bySession = new Map(roster.filter((row) => row?.session_id).map((row) => [row.session_id, row]));
  return rows.map((worker) => workerView(worker, bySession.get(worker.session_id) ?? null));
}

export async function peekWorker(name, { projectId = null, lines = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  return capturePane(worker.tmux_session, lines);
}

export function attachWorker(name, { projectId = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  return attachSession(worker.tmux_session);
}

function callerSessionId() {
  return [
    process.env.GOLEM_CALLER_SESSION_ID,
    process.env.GOLEM_CEO_SESSION_ID,
    process.env.GOLEM_SESSION_ID,
    process.env.CLAUDE_CODE_SESSION_ID,
    process.env.PI_SESSION_ID,
  ].map((value) => (typeof value === 'string' ? value.trim() : '')).find(Boolean) || null;
}

export async function killWorker(name, {
  projectId = null,
  callerId = callerSessionId(),
} = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  if (worker.session_id && callerId && worker.session_id === callerId) {
    throw new Error(`refusing to kill the caller's own session: ${worker.session_id}`);
  }

  let tmuxError = null;
  try {
    killSession(worker.tmux_session);
  } catch (error) {
    tmuxError = error;
  }
  let survivors = [];
  if (worker.pid) survivors = await terminateProcessGroup(worker.pid);
  if (survivors.length) {
    try {
      updateWorker(worker.worker_id, {
        state: 'failed',
        error: `teardown left process-group survivors: ${survivors.join(', ')}`,
      });
    } catch {}
    throw new Error(`worker teardown left process-group survivors: ${survivors.join(', ')}`);
  }
  if (worker.session_id) {
    try { markSessionFactsEnded([worker.session_id], { status: 'stopped' }); } catch {}
    try { markSessionsEnded([worker.session_id], { status: 'stopped' }); } catch {}
  }
  const dead = updateWorker(worker.worker_id, {
    state: 'dead',
    ended_at: new Date().toISOString(),
    error: tmuxError ? tmuxError.message : null,
    survivors: [],
  });
  if (tmuxError) throw tmuxError;
  return workerView(dead, null);
}

export const workerManager = Object.freeze({
  resolveWorkerProject,
  waitForWorkerRegistration,
  spawnWorker,
  listWorkerViews,
  peekWorker,
  attachWorker,
  killWorker,
});
