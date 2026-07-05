import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BUILTIN_ROLES = Object.freeze([
  { name: 'manager', color: '#f59e0b', glyph: 'MG', builtin: true },
  { name: 'planner', color: '#a78bfa', glyph: 'PL', builtin: true },
  { name: 'builder', color: '#4ade80', glyph: 'BU', builtin: true },
  { name: 'explorer', color: '#38bdf8', glyph: 'EX', builtin: true },
]);
export const ROLE_MIGRATIONS = Object.freeze({ general: 'manager', researcher: 'explorer', 'ui-tester': 'explorer' });
export const SESSION_ROLES = new Proxy([], {
  get(_target, prop) {
    const roles = roleNames();
    const value = roles[prop];
    return typeof value === 'function' ? value.bind(roles) : value;
  },
  ownKeys() { return Reflect.ownKeys(roleNames()); },
  getOwnPropertyDescriptor(_target, prop) { return Object.getOwnPropertyDescriptor(roleNames(), prop); },
});
export const SESSION_ROLE_UPDATED_BY = Object.freeze(['human:dashboard', 'human:cli', 'self:mcp']);

let roleRegistryCache = null;

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

function rolesOverlayDir() {
  return path.join(golemHome(), 'roles');
}

function rolesIndexPath() {
  return path.join(rolesOverlayDir(), 'index.json');
}

function roleOverlayPath(role) {
  return path.join(rolesOverlayDir(), `${role}.md`);
}

function roleDefaultPath(role) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'roles', `${role}.md`),
    path.join(here, '..', 'plugin', 'roles', `${role}.md`),
    path.join(here, '..', 'substrate', 'roles', `${role}.md`),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}

function roleCardPath(role) {
  const overlay = roleOverlayPath(role);
  try { if (fs.statSync(overlay).isFile()) return overlay; } catch { /* ignore */ }
  if (process.env.GOLEM_ROLES_DIR) {
    const custom = path.join(process.env.GOLEM_ROLES_DIR, `${role}.md`);
    try { if (fs.statSync(custom).isFile()) return custom; } catch { /* ignore */ }
  }
  return roleDefaultPath(role);
}

export function readRoleCard(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return null;
  const p = roleCardPath(normalized);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf8').trimEnd(); } catch { return null; }
}

function normalizeRoleName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(value)) throw new Error('role name must be 2-32 chars: a-z, 0-9, hyphen; start with a letter');
  return value;
}

function normalizeRoleMeta(role, fallback = {}) {
  const name = normalizeRoleName(role?.name ?? fallback.name);
  const color = String(role?.color ?? fallback.color ?? '#8a909c').trim() || '#8a909c';
  const glyph = String(role?.glyph ?? fallback.glyph ?? name.slice(0, 2).toUpperCase()).trim().slice(0, 4) || name.slice(0, 2).toUpperCase();
  return { name, color, glyph, builtin: role?.builtin === true || fallback.builtin === true };
}

function readRolesIndexRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(rolesIndexPath(), 'utf8'));
    if (Array.isArray(parsed?.roles)) return parsed.roles;
  } catch { /* seed below */ }
  return null;
}

function writeRolesIndex(roles) {
  fs.mkdirSync(rolesOverlayDir(), { recursive: true });
  const target = rolesIndexPath();
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, roles }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  roleRegistryCache = null;
}

export function migrateSessionRoles({ actor = 'system:role-migration' } = {}) {
  const file = sessionsJsonPath();
  const now = new Date().toISOString();
  let changed = false;
  let migrated = [];
  try {
    withFileLock(`${file}.lock`, () => {
      const reg = readRegistry(file);
      reg.sessions = reg.sessions.map((s) => {
        const nextRole = ROLE_MIGRATIONS[s.role];
        if (!nextRole) return s;
        changed = true;
        const next = {
          ...s,
          role: nextRole,
          role_updated_at: now,
          role_updated_by: actor,
          role_migrated_from: s.role,
        };
        migrated.push({ session_id: s.session_id, name: s.name ?? null, from: s.role, to: nextRole });
        return next;
      });
      if (changed) writeRegistry(file, reg);
    });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return { changed, migrated };
}

export function readRoleRegistry() {
  if (roleRegistryCache) return roleRegistryCache.map((r) => ({ ...r }));
  const byName = new Map(BUILTIN_ROLES.map((r) => [r.name, normalizeRoleMeta(r)]));
  const raw = readRolesIndexRaw();
  if (raw) {
    byName.clear();
    for (const item of raw) {
      try {
        const role = normalizeRoleMeta(item);
        if (!ROLE_MIGRATIONS[role.name]) byName.set(role.name, role);
      } catch { /* skip invalid old rows */ }
    }
    for (const builtin of BUILTIN_ROLES) if (!byName.has(builtin.name)) byName.set(builtin.name, normalizeRoleMeta(builtin));
  }
  const roles = [...byName.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  writeRolesIndex(roles);
  migrateSessionRoles();
  roleRegistryCache = roles;
  return roles.map((r) => ({ ...r }));
}

export function roleNames() {
  return readRoleRegistry().map((r) => r.name);
}

export function getRole(name) {
  let normalized = null;
  try {
    normalized = normalizeRoleName(name);
  } catch {
    return null;
  }
  return readRoleRegistry().find((r) => r.name === normalized) || null;
}

export function createRole({ name, color, glyph, body } = {}) {
  const meta = normalizeRoleMeta({ name, color, glyph, builtin: false });
  const roles = readRoleRegistry();
  if (roles.some((r) => r.name === meta.name)) throw new Error(`role already exists: ${meta.name}`);
  writeRolesIndex([...roles, meta].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)));
  if (body != null && String(body).trim()) writeRoleCard(meta.name, body);
  return listRoleCards().find((r) => r.name === meta.name);
}

function assignedSessionsForRole(role) {
  const reg = readRegistry(sessionsJsonPath());
  return reg.sessions.filter((s) => s.role === role);
}

export function deleteRole(name, { force = false } = {}) {
  const normalized = normalizeRoleName(name);
  const roles = readRoleRegistry();
  const role = roles.find((r) => r.name === normalized);
  if (!role) throw new Error(`role not found: ${normalized}`);
  if (role.builtin) throw new Error(`cannot delete builtin role: ${normalized}`);
  const assigned = assignedSessionsForRole(normalized);
  if (assigned.length && !force) throw new Error(`role is assigned to ${assigned.length} session(s)`);
  if (assigned.length && force) {
    const file = sessionsJsonPath();
    const now = new Date().toISOString();
    withFileLock(`${file}.lock`, () => {
      const reg = readRegistry(file);
      reg.sessions = reg.sessions.map((s) => s.role === normalized ? { ...s, role: null, role_updated_at: now, role_updated_by: 'system:role-delete' } : s);
      writeRegistry(file, reg);
    });
  }
  writeRolesIndex(roles.filter((r) => r.name !== normalized));
  return { ok: true, role: normalized, cleared_sessions: force ? assigned.length : 0 };
}

export function updateRoleMeta(name, patch = {}) {
  const normalized = normalizeRoleName(name);
  const roles = readRoleRegistry();
  const idx = roles.findIndex((r) => r.name === normalized);
  if (idx < 0) throw new Error(`role not found: ${normalized}`);
  roles[idx] = normalizeRoleMeta({ ...roles[idx], color: patch.color ?? roles[idx].color, glyph: patch.glyph ?? roles[idx].glyph, builtin: roles[idx].builtin });
  writeRolesIndex(roles);
  return roles[idx];
}

export function listRoleCards() {
  return readRoleRegistry().map((meta) => {
    const role = meta.name;
    const overlay = roleOverlayPath(role);
    const defaultPath = roleDefaultPath(role);
    let currentPath = null;
    let overridden = false;
    let updated_at = null;
    try {
      const st = fs.statSync(overlay);
      if (st.isFile()) {
        currentPath = overlay;
        overridden = true;
        updated_at = st.mtime.toISOString();
      }
    } catch { /* no override */ }
    if (!currentPath) currentPath = defaultPath;
    let body = '';
    if (currentPath) {
      try { body = fs.readFileSync(currentPath, 'utf8').trimEnd(); } catch { body = ''; }
    }
    return { ...meta, body, overridden, updated_at, default_path: defaultPath, overlay_path: overlay };
  });
}

export function writeRoleCard(role, body) {
  const normalized = normalizeRole(role);
  if (!normalized) throw new Error('role is required');
  const text = String(body ?? '').trimEnd();
  if (!text.trim()) throw new Error('role body cannot be empty');
  fs.mkdirSync(rolesOverlayDir(), { recursive: true });
  const target = roleOverlayPath(normalized);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${text}\n`, 'utf8');
  fs.renameSync(tmp, target);
  const st = fs.statSync(target);
  return { name: normalized, body: text, overridden: true, updated_at: st.mtime.toISOString(), overlay_path: target, default_path: roleDefaultPath(normalized) };
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
  const value = normalizeRoleName(role);
  const roles = roleNames();
  if (!roles.includes(value)) {
    throw new Error(`invalid session role: ${value} (expected ${roles.join('|')} or clear)`);
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
