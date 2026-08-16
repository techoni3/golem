import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workersJsonPath } from './golem-home.js';
import { withRegistryLock } from './session-facts.js';

export const WORKERS_REGISTRY_VERSION = 1;
const ACTIVE_STATES = new Set(['spawning', 'live', 'failed']);

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== WORKERS_REGISTRY_VERSION || !Array.isArray(parsed.workers)) {
      throw new Error(`invalid workers registry schema at ${file}`);
    }
    return { version: WORKERS_REGISTRY_VERSION, workers: parsed.workers };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: WORKERS_REGISTRY_VERSION, workers: [] };
    throw new Error(`cannot read workers registry at ${file}: ${error.message}`, { cause: error });
  }
}

function writeRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalizeName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('worker name is required');
  const value = name.trim();
  if (value.length > 80 || /[\r\n]/.test(value)) throw new Error('worker name must be 1-80 characters without newlines');
  return value;
}

function scoped(row, projectId) {
  return projectId == null || row.project_id === projectId;
}

function occupied(row) {
  return ACTIVE_STATES.has(String(row?.state || '').toLowerCase());
}

function nextName(role, projectId, workers) {
  for (let index = 1; ; index += 1) {
    const candidate = `${role}${index}`;
    // tmux names are machine-global on the dedicated golem socket. The
    // project scope still drives the role's sequence, but an active worker in
    // another project must not collide with the tmux identifier.
    const collision = workers.some((row) => row.name === candidate && occupied(row));
    if (!collision) return candidate;
  }
}

function findIndex(workers, workerId) {
  return workers.findIndex((row) => row.worker_id === workerId);
}

export function readWorkers({ file = workersJsonPath() } = {}) {
  return readRegistry(file).workers.map((row) => clone(row));
}

export function withWorkersRegistryLock(fn, { file = workersJsonPath() } = {}) {
  return withRegistryLock(file, () => fn({ file, registry: readRegistry(file) }));
}

/** Claim the name and persist the spawning record before tmux is touched. */
export function claimWorker({
  role,
  projectId,
  projectRoot = null,
  cwd = projectRoot,
  name = null,
  preset,
  file = workersJsonPath(),
  now = Date.now(),
} = {}) {
  if (typeof role !== 'string' || !role.trim()) throw new Error('worker role is required');
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('worker project_id is required');
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('worker preset is required');
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const workerName = name == null ? nextName(role.trim(), projectId, registry.workers) : normalizeName(name);
    const collision = registry.workers.find((row) => row.name === workerName && occupied(row));
    if (collision) {
      throw new Error(`worker name already exists: ${workerName}${collision.project_id ? ` (project ${collision.project_id})` : ''}`);
    }
    const timestamp = iso(now);
    const worker = {
      worker_id: crypto.randomUUID(),
      session_id: null,
      name: workerName,
      role: role.trim(),
      project_id: projectId.trim(),
      project_root: projectRoot,
      cwd: cwd || projectRoot,
      tmux_session: workerName,
      pid: null,
      preset: clone(preset),
      state: 'spawning',
      spawned_at: timestamp,
      updated_at: timestamp,
      ended_at: null,
      error: null,
    };
    registry.workers.push(worker);
    writeRegistry(file, registry);
    return clone(worker);
  });
}

export function updateWorker(workerId, patch = {}, { file = workersJsonPath(), now = Date.now() } = {}) {
  if (typeof workerId !== 'string' || !workerId.trim()) throw new Error('worker_id is required');
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const index = findIndex(registry.workers, workerId);
    if (index < 0) throw new Error(`worker not found: ${workerId}`);
    const current = registry.workers[index];
    const next = {
      ...current,
      ...patch,
      worker_id: current.worker_id,
      updated_at: iso(now),
    };
    registry.workers[index] = next;
    writeRegistry(file, registry);
    return clone(next);
  });
}

export function findWorker(name, { projectId = null, file = workersJsonPath() } = {}) {
  const workerName = normalizeName(name);
  const rows = readRegistry(file).workers.filter((row) => row.name === workerName && scoped(row, projectId));
  const active = rows.filter(occupied);
  if (active.length > 1 && projectId == null) {
    throw new Error(`worker name is ambiguous: ${workerName}; pass --project`);
  }
  // A dead record is retained as history, but a reused name must resolve to
  // the current active row rather than the oldest tombstone.
  const row = active[0] || rows[rows.length - 1];
  return row ? clone(row) : null;
}

export function listWorkers({ projectId = null, file = workersJsonPath() } = {}) {
  return readRegistry(file).workers.filter((row) => scoped(row, projectId)).map((row) => clone(row));
}

export function activeWorkerStates() {
  return new Set(ACTIVE_STATES);
}
