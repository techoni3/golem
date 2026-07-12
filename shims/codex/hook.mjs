#!/usr/bin/env node
// Normalize documented Codex hook fields only. Transcript contents are
// intentionally ignored because OpenAI documents that format as unstable.
import { upsertSessionFact } from '../lib/session-facts.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.exit(0); }
if (!input.session_id || !input.cwd) process.exit(0);
const event = process.argv[2] || 'unknown';
const documented = {
  hook_event_name: input.hook_event_name, source: input.source, turn_id: input.turn_id,
  model: input.model, permission_mode: input.permission_mode, tool_name: input.tool_name,
  tool_use_id: input.tool_use_id, tool_input: input.tool_input, tool_response: input.tool_response,
  prompt: input.prompt, trigger: input.trigger, agent_id: input.agent_id,
  agent_type: input.agent_type, stop_hook_active: input.stop_hook_active,
  last_assistant_message: input.last_assistant_message,
};
const observations = Object.fromEntries(Object.entries(documented).filter(([, value]) => value !== undefined));
try {
  const fact = {
    canonical_id: input.session_id, continuation_key: input.session_id,
    harness: 'codex', locator: { raw_session_id: input.session_id }, project_path: input.cwd,
    ...(event === 'stop' ? { status: 'idle' } : event === 'subagent-stop' ? {} : { status: 'active' }),
    delivery: { mode: 'pull', push: false }, lifecycle_event: event, observations,
  };
  upsertSessionFact(fact);
} catch {}
