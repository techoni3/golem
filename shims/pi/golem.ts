import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function golem(pi) {
  const home = process.env.GOLEM_HOME || path.join(os.homedir(), '.golem');
  let canonicalId;
  function record(ctx, event, status, observations = {}) {
    const id = ctx.sessionManager.getSessionId();
    canonicalId = id;
    const file = path.join(home, 'session-facts.json');
    try {
      fs.mkdirSync(home, { recursive: true });
      let registry = { version: 1, facts: [] };
      try { registry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (registry.version !== 1 || !Array.isArray(registry.facts)) return;
      const i = registry.facts.findIndex((fact) => fact.canonical_id === id);
      const old = i < 0 ? {} : registry.facts[i];
      const fact = { ...old, canonical_id: id, continuation_key: id, harness: 'pi',
        locator: { session_id: id, session_file: ctx.sessionManager.getSessionFile() }, project_path: ctx.cwd,
        name: ctx.sessionManager.getSessionName(), status, delivery: { mode: 'next_turn', push: false },
        lifecycle_event: event, observations, revision: (old.revision || 0) + 1, observed_at: new Date().toISOString() };
      if (i < 0) registry.facts.push(fact); else registry.facts[i] = fact;
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file);
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
    try {
      const lines = fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean);
      if (!lines.length) return;
      const messages = lines.map((line) => JSON.parse(line)).filter((x) => typeof x?.text === 'string');
      fs.renameSync(inbox, `${inbox}.claimed.${Date.now()}`);
      if (messages.length) return { action: 'transform', text: `${_event.text}\n\n${messages.map((x) => x.text).join('\n\n')}` };
    } catch {}
  });
}
