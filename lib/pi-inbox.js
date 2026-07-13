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
      const file = path.join(dir, name); const lock = path.join(dir, '.claims', name);
      try {
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        try { fs.mkdirSync(lock); } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const lease = JSON.parse(fs.readFileSync(path.join(lock, 'lease.json'), 'utf8'));
          if (lease.owner === ownerToken) { /* resume own partial settlement */ }
          else if (lease.expires_at > nowMs) continue;
          else {
          fs.renameSync(lock, `${lock}.stale.${ownerToken}.${nowMs}`); fs.mkdirSync(lock);
          }
        }
        fs.writeFileSync(path.join(lock, 'lease.json'), JSON.stringify({ owner: ownerToken, expires_at: nowMs + leaseMs }), { mode: 0o600 });
        out.push({ file, lock, ownerToken, value: JSON.parse(fs.readFileSync(file, 'utf8')) });
      } catch {
        try { fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'malformed'), { recursive: true }); fs.renameSync(file, path.join(dir, 'malformed', path.basename(file))); } catch {}
      }
    }
  }
  return out;
}

export function checkpointPiPickupAck(file, value) {
  const tmp = `${file}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file);
}

export function completePiPickupAck(ack) {
  const lease = JSON.parse(fs.readFileSync(path.join(ack.lock, 'lease.json'), 'utf8'));
  if (lease.owner !== ack.ownerToken) throw new Error('ack lease owner changed');
  fs.unlinkSync(ack.file); fs.rmSync(ack.lock, { recursive: true, force: true });
}
