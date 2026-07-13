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
    const root = path.join(home, 'pi-inbox', id); const pending = path.join(root, 'pending');
    const messages = []; const processingDir = path.join(root, 'processing');
    const work = [
      ...(fs.existsSync(processingDir) ? fs.readdirSync(processingDir).sort().map((name) => ({ name, source: path.join(processingDir, name), claimed: true })) : []),
      ...(fs.existsSync(pending) ? fs.readdirSync(pending).sort().map((name) => ({ name, source: path.join(pending, name), claimed: false })) : []),
    ];
    for (const item of work) {
      const { name, source } = item; const processing = path.join(root, 'processing', name);
      try {
        fs.mkdirSync(path.dirname(processing), { recursive: true }); if (!item.claimed) fs.renameSync(source, processing);
        const value = JSON.parse(fs.readFileSync(processing, 'utf8'));
        if (typeof value?.text !== 'string') throw new Error('invalid text');
        messages.push(value); fs.mkdirSync(path.join(root, 'acks'), { recursive: true });
        fs.renameSync(processing, path.join(root, 'acks', name));
      } catch {
        try { fs.mkdirSync(path.join(root, 'dead-letter'), { recursive: true }); fs.renameSync(processing, path.join(root, 'dead-letter', name)); } catch {}
      }
    }
    if (messages.length) return { action: 'transform', text: `${_event.text}\n\n${messages.map((x) => x.text).join('\n\n')}` };
  });
}
