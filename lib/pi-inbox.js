import fs from 'node:fs';
import path from 'node:path';
import { golemHome } from './golem-home.js';
import { readSessionFacts } from './session-facts.js';

export function piInboxPath(canonicalId, { home = golemHome() } = {}) {
  if (!canonicalId || canonicalId.includes('/') || canonicalId.includes('\\')) throw new Error('valid canonical Pi session id required');
  return path.join(home, 'pi-inbox', `${canonicalId}.jsonl`);
}

// One O_APPEND write is the durable acceptance boundary. The Pi reader claims
// by rename, so a concurrent append either lands in the claimed inode or a new
// inbox; neither case overwrites another producer.
export function enqueuePiBrief(canonicalId, text, metadata = {}, options = {}) {
  const fact = readSessionFacts(options).find((row) => row.canonical_id === canonicalId && row.harness === 'pi');
  if (!fact) return { ok: false, error: 'target is not a canonical Pi session' };
  const file = piInboxPath(canonicalId, { home: options.home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = `${JSON.stringify({ schema: 1, text, metadata, queued_at: new Date().toISOString() })}\n`;
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  try { fs.writeSync(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { ok: true, queued: true, delivery: 'next_turn', path: file };
}
