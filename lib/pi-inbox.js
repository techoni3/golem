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
  if (fs.existsSync(canonical)) return { ok: true, queued: true, delivery: 'next_turn', message_id: messageId, path: canonical, replay: true };
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, canonical); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  fs.unlinkSync(tmp);
  try { fs.linkSync(canonical, final); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { ok: true, queued: true, delivery: 'next_turn', message_id: messageId, path: final };
}

export function claimPiPickupAcks({ home = golemHome() } = {}) {
  const base = path.join(home, 'pi-inbox'); const out = [];
  for (const session of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, session, 'acks');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((value) => value.includes('.json')) : []) {
      const file = path.join(dir, name); const claim = name.includes('.claim.') ? file : `${file}.claim.${process.pid}`;
      try {
        if (claim !== file) fs.renameSync(file, claim);
        out.push({ file: claim, value: JSON.parse(fs.readFileSync(claim, 'utf8')) });
      } catch {
        try { fs.mkdirSync(path.join(dir, 'malformed'), { recursive: true }); fs.renameSync(claim, path.join(dir, 'malformed', path.basename(claim))); } catch {}
      }
    }
  }
  return out;
}

export function checkpointPiPickupAck(file, value) {
  const tmp = `${file}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file);
}
