#!/usr/bin/env node
// Normalize documented Codex hook fields only. Transcript contents are
// intentionally ignored because OpenAI documents that format as unstable.
import fs from 'node:fs';
import path from 'node:path';
import { upsertSessionFact, supersedePriorCodexFacts } from '../lib/session-facts.js';
import { upsertSessionRegistration, supersedePriorCodexSessions } from '../lib/session-registry.js';
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

const rawSessionId = input.session_id;

// Lightweight read — the Codex plugin bundle does not ship codex-supervisor.js.
function readSupervisorRows() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(golemHome(), 'codex-supervisors.json'), 'utf8'));
    return Array.isArray(parsed?.supervisors) ? parsed.supervisors : [];
  } catch {
    return [];
  }
}

// Prefer env bind, else map raw thread id → managed canonical when a supervisor
// already owns this thread (ordinary hooks run without GOLEM_MANAGED_* env).
const envBound = process.env.GOLEM_MANAGED_CODEX_BOUND === '1'
  && typeof process.env.GOLEM_MANAGED_CODEX_BOUND_SESSION_ID === 'string'
  && process.env.GOLEM_MANAGED_CODEX_BOUND_SESSION_ID.trim()
  ? process.env.GOLEM_MANAGED_CODEX_BOUND_SESSION_ID.trim()
  : null;
const ownerByThread = (() => {
  const map = new Map();
  for (const row of readSupervisorRows()) {
    if (row?.thread_id && row?.canonical_id) map.set(row.thread_id, row.canonical_id);
  }
  return map;
})();
const managedBound = envBound || ownerByThread.get(rawSessionId) || null;
const canonicalId = managedBound || rawSessionId;

function protectOtherManagedCanonicals(keepId) {
  return readSupervisorRows()
    .filter((row) => row?.canonical_id && row.canonical_id !== keepId && row.thread_id)
    .map((row) => row.canonical_id);
}

let projectRoot = input.cwd;
try {
  projectRoot = await resolveProjectRoot(input.cwd);
} catch {
  projectRoot = input.cwd;
}

if (event === 'session-start') {
  try {
    const registered = await upsertSessionRegistration({
      sessionId: canonicalId,
      cwd: input.cwd,
      harness: 'codex',
      model: input.model,
    });
    projectRoot = registered.project_path || projectRoot;
    const protect = protectOtherManagedCanonicals(canonicalId);
    supersedePriorCodexSessions({
      projectPath: projectRoot,
      keepSessionId: canonicalId,
      protectSessionIds: protect,
    });
    supersedePriorCodexFacts({
      projectPath: projectRoot,
      keepCanonicalIds: [canonicalId, rawSessionId].filter(Boolean),
      protectCanonicalIds: protect,
    });
  } catch {}
}
let lifecycle;
try {
  lifecycle = recordCodexLifecycle({
    home: golemHome(),
    projectPath: projectRoot,
    rawSessionId,
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
  // Turn `stop` must NOT mark the session fact session-terminal: Codex fires
  // stop per turn. Session retirement uses ended_at / superseded via SessionStart
  // succession or explicit supervisor death (dead|stopped|failed).
  const turnStop = event === 'stop';
  const status = turnStop
    ? 'idle'
    : event === 'subagent-stop'
      ? undefined
      : 'active';
  const fact = {
    canonical_id: canonicalId,
    continuation_key: canonicalId,
    harness: 'codex',
    locator: { raw_session_id: rawSessionId },
    project_path: projectRoot,
    model: input.model,
    ...(status ? { status } : {}),
    lifecycle_state: lifecycle?.record?.state ?? (turnStop ? 'idle' : 'active'),
    generation_id: lifecycle?.record?.generation_id,
    project_id: lifecycle?.record?.project_id,
    canonical_project_id: lifecycle?.record?.project_id,
    aliases: lifecycle?.record?.aliases,
    delivery: managedBound ? { mode: 'supervisor-turn', push: true } : { mode: 'pull', push: false },
    lifecycle_event: event,
    observations,
  };
  upsertSessionFact(fact);
} catch {}
