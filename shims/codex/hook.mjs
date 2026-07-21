#!/usr/bin/env node
// Normalize documented Codex hook fields only. Transcript contents are
// intentionally ignored because OpenAI documents that format as unstable.
import { upsertSessionFact } from '../lib/session-facts.js';
import { upsertSessionRegistration } from '../lib/session-registry.js';
import { golemHome } from '../lib/golem-home.js';
import { resolveProjectRoot } from '../lib/project-id.js';
import { recordCodexLifecycle } from './direct-lifecycle.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.exit(0); }
if (!input.session_id || !input.cwd) process.exit(0);
const event = process.argv[2] || 'unknown';
const documented = {
  hook_event_name: input.hook_event_name, source: input.source, turn_id: input.turn_id,
  model: input.model, permission_mode: input.permission_mode, tool_name: input.tool_name,
  tool_use_id: input.tool_use_id, trigger: input.trigger, agent_id: input.agent_id,
  agent_type: input.agent_type, stop_hook_active: input.stop_hook_active,
};
const observations = Object.fromEntries(Object.entries(documented).filter(([, value]) => value !== undefined));
if (event === 'session-start') {
  try {
    await upsertSessionRegistration({
      sessionId: input.session_id,
      cwd: input.cwd,
      harness: 'codex',
      model: input.model,
    });
  } catch {}
}
let lifecycle;
try {
  const projectRoot = await resolveProjectRoot(input.cwd);
  lifecycle = recordCodexLifecycle({
    home: golemHome(),
    projectPath: projectRoot,
    rawSessionId: input.session_id,
    event,
    model: typeof input.model === 'string' ? input.model : undefined,
    threadId: typeof input.thread_id === 'string' ? input.thread_id : (typeof input.turn_id === 'string' ? input.turn_id : undefined),
    resume: event === 'session-start' && input.source === 'resume',
  });
} catch {
  // Lifecycle integration is fail-open: a native Codex launch must continue
  // even if the optional Golem home or its filesystem inbox is unavailable.
}
try {
  const fact = {
    canonical_id: input.session_id, continuation_key: input.session_id,
    harness: 'codex', locator: { raw_session_id: input.session_id }, project_path: input.cwd,
    model: input.model,
    ...(event === 'stop' ? { status: 'ended' } : event === 'subagent-stop' ? {} : { status: lifecycle?.terminal ? 'ended' : 'active' }),
    lifecycle_state: lifecycle?.record?.state ?? (event === 'stop' ? 'ended' : 'active'),
    generation_id: lifecycle?.record?.generation_id,
    project_id: lifecycle?.record?.project_id,
    canonical_project_id: lifecycle?.record?.project_id,
    aliases: lifecycle?.record?.aliases,
    delivery: { mode: 'pull', push: false }, lifecycle_event: event, observations,
  };
  upsertSessionFact(fact);
} catch {}
