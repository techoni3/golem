import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SESSION_ROLES = Object.freeze(['planner', 'builder', 'researcher', 'ui-tester']);
export const SESSION_ROLE_UPDATED_BY = Object.freeze(['human:dashboard', 'human:cli', 'self:mcp']);

function isRealDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'golem');
  const migrated = path.join(os.homedir(), '.golem');
  if (isRealDir(migrated)) return migrated;
  return path.join(os.homedir(), '.config', 'golem');
}

export function sessionsJsonPath() {
  return path.join(golemHome(), 'sessions.json');
}

function channelsJsonPath() {
  return path.join(golemHome(), 'channels.json');
}

function roleCardPath(role) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.GOLEM_ROLES_DIR ? path.join(process.env.GOLEM_ROLES_DIR, `${role}.md`) : null,
    path.join(here, '..', 'roles', `${role}.md`),
    path.join(here, '..', 'plugin', 'roles', `${role}.md`),
    path.join(here, '..', 'substrate', 'roles', `${role}.md`),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}

export function readRoleCard(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return null;
  const p = roleCardPath(normalized);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf8').trimEnd(); } catch { return null; }
}

export function roleChangeBrief(role, row = {}) {
  const normalized = normalizeRole(role);
  if (!normalized) return null;
  const card = readRoleCard(normalized);
  if (!card) return null;
  const name = row.name || row.session_id || 'this session';
  return `your role is now ${normalized}\n\n${card}\n\nRoster: ${name} is assigned role ${normalized}.`;
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.sessions)) return parsed;
  } catch { /* ignore */ }
  return { version: 1, sessions: [] };
}

function writeRegistry(file, reg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, file);
}

function withFileLock(lockPath, fn) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < 50; i++) {
    try {
      fs.mkdirSync(lockPath);
      try { return fn(); }
      finally { try { fs.rmdirSync(lockPath); } catch { /* ignore */ } }
    } catch (err) {
      if (err?.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 5000) fs.rmdirSync(lockPath);
        } catch { /* ignore */ }
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* brief spin */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to acquire ${lockPath}`);
}

function normalizeRole(role) {
  if (role == null || role === '' || role === 'clear') return null;
  const value = String(role);
  if (!SESSION_ROLES.includes(value)) {
    throw new Error(`invalid session role: ${value} (expected ${SESSION_ROLES.join('|')} or clear)`);
  }
  return value;
}

function validateBy(by) {
  if (!SESSION_ROLE_UPDATED_BY.includes(by)) {
    throw new Error(`invalid role updater: ${by} (expected ${SESSION_ROLE_UPDATED_BY.join('|')})`);
  }
}

function projectIdFor(root) {
  const base = path.basename(root || 'project');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const hash = crypto.createHash('sha256').update(String(root || '')).digest('hex').slice(0, 6);
  return `${slug}-${hash}`;
}

function appendRoleJournal(row, role, by, ts) {
  const projectId = row.project_id || (row.project_path ? projectIdFor(row.project_path) : null);
  if (!projectId) return;
  try {
    const dir = path.join(golemHome(), 'journals', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const text = `session role ${role ?? 'cleared'} for ${row.name || row.session_id} by ${by}`;
    fs.appendFileSync(path.join(dir, 'hook.jsonl'), JSON.stringify({
      ts,
      event: 'milestone',
      session_id: row.session_id,
      project_id: projectId,
      text,
    }) + '\n');
  } catch { /* audit is best-effort; role write already succeeded */ }
}

export function setSessionRole(sessionId, role, { by } = {}) {
  if (!sessionId) throw new Error('session id is required');
  validateBy(by);
  const nextRole = normalizeRole(role);
  const file = sessionsJsonPath();
  const now = new Date().toISOString();
  return withFileLock(`${file}.lock`, () => {
    const reg = readRegistry(file);
    let updated = null;
    reg.sessions = reg.sessions.map((s) => {
      if (s.session_id !== sessionId) return s;
      updated = {
        ...s,
        role: nextRole,
        role_updated_at: now,
        role_updated_by: by,
      };
      return updated;
    });
    if (!updated) throw new Error(`session not found: ${sessionId}`);
    writeRegistry(file, reg);
    appendRoleJournal(updated, nextRole, by, now);
    return updated;
  });
}

function pidAlive(pid) {
  if (!pid || pid === 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readChannels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(channelsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.channels) ? parsed.channels : [];
  } catch {
    return [];
  }
}

export async function pushRoleBriefDirect(sessionId, role, row = {}) {
  const content = roleChangeBrief(role, { session_id: sessionId, ...row });
  if (!sessionId || !content) return { ok: false, skipped: true };
  const ch = readChannels().find((c) => c.session_id === sessionId && pidAlive(c.pid));
  const baseUrl = ch?.url || (ch?.host && ch?.port ? `http://${ch.host}:${ch.port}` : null);
  if (!baseUrl) return { ok: false, skipped: true };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/brief`, {
      method: 'POST',
      headers: { 'X-Sender': 'cli', 'Content-Type': 'text/plain' },
      body: content,
      signal: ctl.signal,
    });
    return { ok: resp.ok, status: resp.status, target: baseUrl };
  } catch {
    return { ok: false, skipped: true, target: baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

export function validateSessionRole(role) {
  return normalizeRole(role);
}
