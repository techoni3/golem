import fs from 'node:fs';
import path from 'node:path';
import { golemHome } from './lib/golem-home.js';
import { upsertSessionFact } from './lib/session-facts.js';

export default function golem(pi) {
  const home = golemHome();
  let canonicalId;
  function record(ctx, event, status, observations = {}) {
    const id = ctx.sessionManager.getSessionId();
    canonicalId = id;
    try {
      upsertSessionFact({ canonical_id: id, continuation_key: id, harness: 'pi',
        locator: { raw_session_id: id, session_file: ctx.sessionManager.getSessionFile() }, project_path: ctx.cwd,
        name: ctx.sessionManager.getSessionName(), status, delivery: { mode: 'next_turn', push: false },
        lifecycle_event: event, observations, observed_at: new Date().toISOString() });
    } catch {}
  }
  pi.on('session_start', (event, ctx) => record(ctx, 'session_start', 'idle', { reason: event.reason }));
  pi.on('session_info_changed', (event, ctx) => record(ctx, 'session_info_changed', ctx.isIdle() ? 'idle' : 'active', { name: event.name }));
  pi.on('agent_start', (_event, ctx) => record(ctx, 'agent_start', 'active'));
  pi.on('agent_settled', (_event, ctx) => record(ctx, 'agent_settled', 'idle'));
  pi.on('tool_call', (event, ctx) => record(ctx, 'tool_call', 'active', { tool_name: event.toolName, tool_call_id: event.toolCallId }));
  pi.on('session_shutdown', (event, ctx) => record(ctx, 'session_shutdown', 'ended', { reason: event.reason }));
  pi.on('input', (_event, ctx) => {
    const id = canonicalId || ctx.sessionManager.getSessionId();
    const inbox = path.join(home, 'pi-inbox', `${id}.jsonl`);
    const claim = `${inbox}.claimed.${process.pid}.${Date.now()}`;
    try { fs.renameSync(inbox, claim); } catch { return; }
    try {
      const messages = [];
      const malformed = [];
      for (const line of fs.readFileSync(claim, 'utf8').split('\n').filter(Boolean)) {
        try { const value = JSON.parse(line); if (typeof value?.text === 'string') messages.push(value); else malformed.push(line); }
        catch { malformed.push(line); }
      }
      if (malformed.length) fs.appendFileSync(`${inbox}.dead-letter.jsonl`, `${malformed.join('\n')}\n`, { mode: 0o600 });
      fs.unlinkSync(claim);
      if (messages.length) return { action: 'transform', text: `${_event.text}\n\n${messages.map((x) => x.text).join('\n\n')}` };
    } catch {
      // Retry the whole claimed batch. If producers already recreated inbox,
      // append the claimed bytes instead of replacing their concurrent writes.
      try { fs.appendFileSync(inbox, fs.readFileSync(claim)); fs.unlinkSync(claim); } catch {}
    }
  });
}
