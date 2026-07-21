import fs from 'node:fs';
import path from 'node:path';
import { golemHome } from './golem-home.js';
import { readSessionFacts } from './session-facts.js';

export function piInboxPath(canonicalId, { home = golemHome() } = {}) {
  if (!canonicalId || canonicalId.includes('/') || canonicalId.includes('\\')) throw new Error('valid canonical Pi session id required');
  return path.join(home, 'pi-inbox', canonicalId);
}

export function enqueuePiBrief(canonicalId, text, metadata = {}, options = {}) {
  const fact = readSessionFacts(options).find((row) => row.canonical_id === canonicalId && row.harness === 'pi');
  if (!fact) return { ok: false, error: 'target is not a canonical Pi session' };
  const root = piInboxPath(canonicalId, { home: options.home });
  const pending = path.join(root, 'pending'); const published = path.join(root, 'published'); fs.mkdirSync(pending, { recursive: true }); fs.mkdirSync(published, { recursive: true });
  const messageId = options.messageId || metadata.queue_id;
  if (!messageId || !/^[A-Za-z0-9_-]+$/.test(messageId)) throw new Error('deterministic messageId required');
  const canonical = path.join(published, `${messageId}.json`); const final = path.join(pending, `${messageId}.json`); const tmp = path.join(root, `.${messageId}.${process.pid}.tmp`);
  const record = JSON.stringify({ schema: 1, message_id: messageId, text, metadata, queued_at: new Date().toISOString() });
  if (fs.existsSync(canonical)) {
    const inFlight = ['processing', 'acks'].some((dir) => fs.existsSync(path.join(root, dir)) && fs.readdirSync(path.join(root, dir)).some((name) => name.startsWith(`${messageId}.json`)));
    if (!inFlight && !fs.existsSync(final)) try { fs.linkSync(canonical, final); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return { ok: true, queued: true, delivery: 'next_turn', message_id: messageId, path: canonical, replay: true };
  }
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, canonical); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  fs.unlinkSync(tmp);
  try { fs.linkSync(canonical, final); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { ok: true, queued: true, delivery: 'next_turn', message_id: messageId, path: final };
}

export function claimPiPickupAcks({ home = golemHome(), ownerToken, nowMs = Date.now(), leaseMs = 30_000 } = {}) {
  if (!ownerToken) throw new Error('ack ownerToken required');
  const base = path.join(home, 'pi-inbox'); const out = [];
  for (const session of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, session, 'acks');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((value) => value.endsWith('.json')) : []) {
      const file = path.join(dir, name); const lockDir = path.join(dir, '.claims'); const lock = path.join(lockDir, name); const candidate = `${lock}.${ownerToken}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(candidate, JSON.stringify({ owner: ownerToken, expires_at: nowMs + leaseMs }), { flag: 'wx', mode: 0o600 });
        try { fs.linkSync(candidate, lock); } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const before = fs.statSync(lock); const lease = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (lease.owner === ownerToken) { fs.unlinkSync(candidate); }
          else if (lease.expires_at > nowMs) { fs.unlinkSync(candidate); continue; }
          else {
            const quarantine = `${lock}.stale.${ownerToken}.${nowMs}`;
            fs.linkSync(lock, quarantine);
            const current = fs.statSync(lock); if (before.ino !== current.ino) { fs.unlinkSync(quarantine); fs.unlinkSync(candidate); continue; }
            try { fs.unlinkSync(lock); } catch { fs.unlinkSync(quarantine); fs.unlinkSync(candidate); continue; }
            try { fs.linkSync(candidate, lock); } catch { fs.unlinkSync(quarantine); fs.unlinkSync(candidate); continue; }
          }
        }
        try { fs.unlinkSync(candidate); } catch {}
        out.push({ file, lock, ownerToken, value: JSON.parse(fs.readFileSync(file, 'utf8')) });
      } catch {
        try { fs.unlinkSync(candidate); } catch {}
        try { fs.mkdirSync(path.join(dir, 'malformed'), { recursive: true }); fs.renameSync(file, path.join(dir, 'malformed', path.basename(file))); } catch {}
      }
    }
  }
  return out;
}

export function checkpointPiPickupAck(file, value) {
  const tmp = `${file}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file);
}

export function completePiPickupAck(ack) {
  const lease = JSON.parse(fs.readFileSync(ack.lock, 'utf8'));
  if (lease.owner !== ack.ownerToken) throw new Error('ack lease owner changed');
  fs.unlinkSync(ack.file); fs.unlinkSync(ack.lock);
}

/**
 * Read-only compatibility inventory for the typed Pi adapter cutover. A legacy
 * inbox row is never inferred from a friendly name or raw Pi id: only a full
 * canonical binding makes it importable. Callers can surface the returned
 * ambiguous ids as diagnostics without moving or deleting durable evidence.
 */
export function inspectLegacyPiInbox({ home = golemHome(), canonicalBinding } = {}) {
  const binding = canonicalBinding && typeof canonicalBinding === 'object' ? canonicalBinding : null;
  const valid = binding && ['project_id', 'session_id', 'generation_id', 'endpoint_id', 'owner_fence'].every((key) => typeof binding[key] === 'string' && binding[key]);
  const root = path.join(home, 'pi-inbox'); const result = { importable: [], ambiguous: [] };
  if (!valid || !fs.existsSync(root)) return result;
  for (const session of fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const pending = path.join(root, session.name, 'pending'); if (!fs.existsSync(pending)) continue;
    for (const name of fs.readdirSync(pending).filter((entry) => entry.endsWith('.json'))) {
      const source = path.join(pending, name);
      try {
        const row = JSON.parse(fs.readFileSync(source, 'utf8')); const rowBinding = row?.metadata?.canonical_binding;
        const matches = rowBinding && ['project_id', 'session_id', 'generation_id', 'endpoint_id', 'owner_fence'].every((key) => rowBinding[key] === binding[key]);
        const id = typeof row?.message_id === 'string' ? row.message_id : name.slice(0, -'.json'.length);
        (matches && typeof row?.text === 'string' && typeof row?.metadata?.claim_token === 'string' ? result.importable : result.ambiguous).push({ session_id: session.name, message_id: id });
      } catch { result.ambiguous.push({ session_id: session.name, message_id: name.slice(0, -'.json'.length) }); }
    }
  }
  result.importable.sort((left, right) => `${left.session_id}/${left.message_id}`.localeCompare(`${right.session_id}/${right.message_id}`));
  result.ambiguous.sort((left, right) => `${left.session_id}/${left.message_id}`.localeCompare(`${right.session_id}/${right.message_id}`));
  return result;
}
