#!/usr/bin/env node
// Normalize documented Codex hook fields only. Transcript contents are
// intentionally ignored because OpenAI documents that format as unstable.
import fs from 'node:fs';
import path from 'node:path';
import { upsertSessionFact, supersedePriorCodexFacts } from '../lib/session-facts.js';
import { upsertSessionRegistration, supersedePriorCodexSessions } from '../lib/session-registry.js';
import { golemHome } from '../lib/golem-home.js';
import { resolveProjectRoot } from '../lib/project-id.js';

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
    delivery: managedBound ? { mode: 'supervisor-turn', push: true } : { mode: 'pull', push: false },
    lifecycle_event: event,
    observations,
  };
  upsertSessionFact(fact);
} catch {}

// L4 ambient context. Codex 0.146.0 accepts the same SessionStart contract as
// Claude Code — `SessionStartHookSpecificOutputWire` in the binary declares
// exactly `{hookEventName, additionalContext}` with `additionalProperties:
// false`, so re-emit those two fields rather than passing the script's JSON
// through: an extra key fails validation and the whole payload is dropped.
//
// Registering the session is NOT delivering context. Until this existed, Codex
// wrote its session fact and returned silently, so ordinary Codex was the one
// harness with no L4 at all while the bundle shipped the script that renders it.
if (event === 'session-start') {
  try {
    // Sibling only. This file imports `../lib/*.js`, which resolves solely inside
    // the rendered bundle (`plugins/golem/{hooks,lib}/`) — running it from the
    // repo checkout fails at import time — so the bundle layout is the only one
    // that can reach here, and a repo-relative fallback would be dead code that
    // makes the resolution look better tested than it is. The codex adapter ships
    // `tracker-context.sh` and `_golem-home.sh` into this directory; if that ever
    // stops, the guard below degrades to no context rather than a broken session.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const script = path.join(here, 'tracker-context.sh');
    if (fs.existsSync(script)) {
      const { execFileSync } = await import('node:child_process');
      const args = [script];
      if (canonicalId) args.push('--session', canonicalId);
      const out = execFileSync('bash', args, {
        encoding: 'utf8',
        timeout: 3000,
        cwd: input.cwd, // the script walks up from $PWD; give it the session's cwd
        input: JSON.stringify({ session_id: canonicalId || '', cwd: input.cwd, harness: 'codex' }),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const additionalContext = JSON.parse(out)?.hookSpecificOutput?.additionalContext;
      if (additionalContext) {
        process.stdout.write(`${JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
        })}\n`);
      }
    }
  } catch {} // fail open: no context is bad, a broken session start is worse
}
