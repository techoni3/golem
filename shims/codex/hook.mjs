#!/usr/bin/env node
// Normalize documented Codex hook fields only. Transcript contents are
// intentionally ignored because OpenAI documents that format as unstable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.exit(0); }
if (!input.session_id || !input.cwd) process.exit(0);
const event = process.argv[2] || 'unknown';
const home = process.env.GOLEM_HOME || path.join(os.homedir(), '.golem');
const file = path.join(home, 'session-facts.json');
const now = new Date().toISOString();
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
  fs.mkdirSync(home, { recursive: true });
  let registry = { version: 1, facts: [] };
  try { registry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (registry.version !== 1 || !Array.isArray(registry.facts)) process.exit(0);
  const index = registry.facts.findIndex((fact) => fact.canonical_id === input.session_id);
  const previous = index < 0 ? null : registry.facts[index];
  const fact = {
    ...(previous || {}), canonical_id: input.session_id, continuation_key: input.session_id,
    harness: 'codex', locator: { raw_session_id: input.session_id }, project_path: input.cwd,
    status: event === 'stop' || event === 'subagent-stop' ? 'idle' : 'active',
    delivery: { mode: 'next_turn', push: false }, lifecycle_event: event,
    observations, revision: (previous?.revision || 0) + 1, observed_at: now,
  };
  if (index < 0) registry.facts.push(fact); else registry.facts[index] = fact;
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
} catch {}
