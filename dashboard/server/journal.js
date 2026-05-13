// Parse journal/hook.jsonl + journal/summary.jsonl into a per-project store of
// agents. An "agent" is keyed by either agent_id (when present, for sub-agents
// whose per-frontmatter hooks expose it in the payload) or session_id (CEO main
// thread, plus legacy sub-agent events without per-agent hook frontmatter).
// This split exists because Claude Code fires per-agent frontmatter hooks with
// the PARENT'S session_id in the outer envelope but stamps the inner payload
// with `agent_id` + `agent_type` — so the only way to distinguish multiple
// sub-agents sharing the same parent session is via agent_id.
//
// Each agent record carries:
//   - identity: session_id, optional agent_id, optional subagent_type/name/
//     team_name (from agent_type for agent_id-keyed records, or correlated
//     from agent-spawn events in the parent session for session-keyed ones)
//   - status: active | running | done (heuristic, see status())
//   - aggregate counters: tool count, runtime (last_seen - first_seen)
//   - journal entries: human-readable mix of summary.jsonl lines for the
//     session + selected hook events ("system" entries)
//   - hooks: {t, tool, args, status} timeline, capped to CONFIG.hookCapPerAgent
//
// We tail hook.jsonl + summary.jsonl by tracking byte offsets so re-reading
// after appends is cheap. Public API:
//
//   const store = createJournalStore(project)
//   await store.bootstrap()                      // full first-pass read
//   const delta = await store.refresh()          // read appended bytes only
//   store.snapshot()                             // current agents + meta
//   store.agentDetail(agentId)                   // full journal+hooks
//
// `delta` describes what changed so the WS layer can forward it to clients
// without re-broadcasting the full state.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.js';
import { roleFromSubagentType } from './roles.js';
import { safeJsonParse, shortId, tsMs, clampList } from './util.js';

function newAgent({ session_id, project, agent_id, agent_type }) {
  const sub = agent_type ?? null;
  return {
    id: agent_id ? `${project}:agent-${agent_id}` : `${project}:${session_id}`,
    project,
    session_id,
    agent_id: agent_id ?? null,
    name: sub ?? `session-${shortId(session_id, 8) || 'unknown'}`,
    subagent_type: sub,
    role: sub ? roleFromSubagentType(sub) : null,
    team_name: null,
    parent_session: agent_id ? session_id : null,
    status: 'active',
    action: null,
    started: null,
    last_seen: null,
    runtime: 0,
    tools: 0,
    tools_running: 0, // tool-pre minus matching tool-post
    stopped: false,   // saw subagent-stop / session-end for this session_id
    journal: [],
    hooks: [],
    pending_hooks: new Map(), // tool_use_id → tool-pre record awaiting post
  };
}

function classifyAgent(a, now = Date.now()) {
  if (a.stopped) return 'done';
  // Tools currently in flight = running, regardless of how long the model has
  // been thinking between hook events. Long generations don't fire hooks.
  if (a.tools_running > 0) return 'running';
  const sinceLast = now - (a.last_seen ?? 0);
  if (sinceLast < CONFIG.agentActiveWindowMs) return 'active';
  if (sinceLast < CONFIG.agentIdleTimeoutMs) return 'active'; // still recent enough
  return 'done';
}

// The hook script (substrate/.../journal-event.sh) writes events as:
//   {ts, event, session_id, cwd, payload: <stringified-JSON-from-Claude-Code>}
// where the *interesting* fields (tool_name, tool_input.subagent_type, etc.)
// live inside payload. Flatten them onto the event so the rest of this file
// can keep using ev.tool_name / ev.subagent_type / ev.tool_input etc. directly.
function normalizeEvent(ev) {
  if (!ev) return ev;
  let payload = ev.payload;
  if (typeof payload === 'string' && payload.length > 0) {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || typeof payload !== 'object') return ev;
  const tool_input = payload.tool_input ?? {};
  return {
    ...ev,
    tool_name: payload.tool_name ?? ev.tool_name,
    tool_input,
    tool_response: payload.tool_response ?? ev.tool_response,
    message: payload.message ?? ev.message,
    // Agent tool spawn fields (on the PARENT'S Agent tool-call payload)
    subagent_type: tool_input.subagent_type ?? ev.subagent_type,
    subagent_name: tool_input.name ?? ev.subagent_name,
    team_name: tool_input.team_name ?? ev.team_name,
    // SendMessage tool field
    send_to: tool_input.to ?? ev.send_to,
    // Per-sub-agent identity, stamped on every event a sub-agent fires from its
    // own frontmatter hooks. Absent on the CEO's own tool calls.
    agent_id: payload.agent_id ?? ev.agent_id,
    agent_type: payload.agent_type ?? ev.agent_type,
    // The Claude-Code-native event name (e.g. "PreToolUse", "Stop",
    // "SubagentStop", "TeammateIdle"). Distinguishes (a) a sub-agent's own
    // frontmatter Stop hook (`Stop` — terminal for that agent) from (b) the
    // parent's settings.json SubagentStop hook (`SubagentStop` — parent
    // observing a child terminate). Both land in our `subagent-stop` event
    // bucket; only hook_event_name tells them apart.
    hook_event_name: payload.hook_event_name ?? ev.hook_event_name,
  };
}

function summariseToolPre(ev) {
  const ti = ev.tool_input ?? {};
  if (ev.tool_name === 'Bash' && ti.command) return `Bash: ${ti.command}`;
  if (ev.tool_name === 'Read' && ti.file_path) return `Read: ${ti.file_path}`;
  if (ev.tool_name === 'Write' && ti.file_path) return `Write: ${ti.file_path}`;
  if (ev.tool_name === 'Edit' && ti.file_path) return `Edit: ${ti.file_path}`;
  if (ev.tool_name === 'Skill' && ti.skill) return `Skill: ${ti.skill}`;
  if (ev.tool_name === 'Agent' && ti.subagent_type) return `Spawn: ${ti.subagent_type}`;
  if (ev.tool_name === 'SendMessage' && ti.to) return `Msg → ${ti.to}`;
  if (ev.tool_name) return ev.tool_name;
  return ev.event;
}

function shortToolArgs(ev) {
  const ti = ev.tool_input ?? {};
  return ti.command || ti.file_path || ti.skill || ti.subagent_type || ti.to || ev.event || '';
}

export function createJournalStore(project) {
  // Keyed by `agent:<agent_id>` for sub-agents (when an agent_id is stamped on
  // the event payload) or `session:<session_id>` for everything else (CEO main
  // thread + legacy events lacking per-frontmatter agent identity).
  const agents = new Map();
  // Recent agent-spawn events, used to enrich newly-appearing agents with
  // team_name / parent_session.
  // Each entry: { spawn_ts, parent_session, subagent_type, subagent_name, team_name, claimed }
  const pendingSpawns = [];

  let hookOffset = 0;
  let summaryOffset = 0;
  // Track unparsed trailing partial line if we hit a chunk mid-write.
  let hookCarry = '';
  let summaryCarry = '';

  function getOrCreate(ev, eventTs) {
    const sid = ev.session_id;
    // Distinguish parent-observation events from sub-agent's own events.
    // Both can carry an agent_id under the parent's session_id, so we use
    // hook_event_name to discriminate:
    //   - `Stop` / `TeammateIdle` → fired from the agent's OWN frontmatter,
    //     event semantically belongs to that agent. Route by agent_id.
    //   - `SubagentStop` → fired from the PARENT'S settings.json when a child
    //     terminates. The child has its own record (via its own Stop fire);
    //     this event is a parent-side notification. Route to parent's session.
    const isParentObservation =
      ev.event === 'subagent-stop' &&
      ev.agent_id &&
      ev.hook_event_name === 'SubagentStop';
    const aid = isParentObservation ? null : (ev.agent_id ?? null);
    const atype = isParentObservation ? null : (ev.agent_type ?? null);
    const key = aid ? `agent:${aid}` : `session:${sid}`;
    let a = agents.get(key);
    if (!a) {
      a = newAgent({ session_id: sid, project: project.id, agent_id: aid, agent_type: atype });
      agents.set(key, a);
      // Try to claim a recent spawn. Use the event timestamp (not Date.now())
      // so the heuristic still works during bootstrap replay.
      const ts = eventTs ?? Date.now();
      for (const sp of pendingSpawns) {
        if (sp.claimed) continue;
        if (Math.abs(ts - sp.spawn_ts) > CONFIG.spawnCorrelationMs) continue;
        // For agent_id-keyed records the subagent_type is already known from
        // agent_type — only match spawns of the same kind, and only use the
        // spawn for team_name / parent_session / friendlier name.
        if (aid) {
          if (sp.subagent_type && atype && sp.subagent_type !== atype) continue;
          sp.claimed = true;
          a.team_name = sp.team_name;
          a.parent_session = sp.parent_session;
          if (sp.subagent_name) a.name = sp.subagent_name;
        } else {
          sp.claimed = true;
          a.subagent_type = sp.subagent_type;
          a.role = roleFromSubagentType(sp.subagent_type);
          a.team_name = sp.team_name;
          a.parent_session = sp.parent_session;
          if (sp.subagent_name) {
            a.name = sp.subagent_name;
          } else if (sp.subagent_type) {
            a.name = sp.subagent_type;
          }
        }
        break;
      }
    }
    return a;
  }

  function applyEvent(ev) {
    if (!ev || !ev.session_id) return null;
    const t = tsMs(ev.ts);
    const a = getOrCreate(ev, t);
    if (a.started == null || t < a.started) a.started = t;
    if (a.last_seen == null || t > a.last_seen) a.last_seen = t;
    a.runtime = Math.max(0, Math.floor(((a.last_seen ?? t) - (a.started ?? t)) / 1000));

    switch (ev.event) {
      case 'agent-spawn': {
        // Spawn fires from the PARENT session — it tells us a sub-agent type
        // exists, but the spawned agent's session_id appears later under its
        // own events. Queue this so newly-appearing sessions can claim it.
        pendingSpawns.push({
          spawn_ts: t,
          parent_session: ev.session_id,
          subagent_type: ev.subagent_type,
          subagent_name: ev.subagent_name,
          team_name: ev.team_name,
          claimed: false,
        });
        // The session that fires agent-spawn IS the orchestrator (main thread).
        // Sub-agents can't recurse, so anyone spawning is the CEO. Label it
        // if it hasn't been labelled yet.
        if (!a.role && !a.subagent_type) {
          a.subagent_type = 'golem-ceo';
          a.role = 'ORC';
          a.team_name = a.team_name ?? 'main';
          a.name = 'CEO';
        }
        // Trim spawns that are way older than the most recent event we're
        // processing — keeps the queue bounded across bootstrap replays too.
        while (
          pendingSpawns.length > 32 ||
          (pendingSpawns.length &&
            t - pendingSpawns[0].spawn_ts > CONFIG.spawnCorrelationMs * 4)
        ) {
          pendingSpawns.shift();
        }
        a.journal.push({
          t, kind: 'system',
          text: `Spawned ${ev.subagent_type ?? 'sub-agent'}${
            ev.team_name ? ` (team: ${ev.team_name})` : ''
          }`,
        });
        break;
      }
      case 'agent-return':
        a.journal.push({
          t, kind: 'system',
          text: `Sub-agent ${ev.subagent_type ?? ''} returned`,
        });
        break;
      case 'send-message':
        a.journal.push({
          t, kind: 'msg',
          text: `→ ${ev.send_to ?? '?'}: ${
            (ev.tool_input?.message ?? '').toString().slice(0, 200) || '(message)'
          }`,
        });
        break;
      case 'tool-pre': {
        a.tools += 1;
        a.tools_running += 1;
        const action = summariseToolPre(ev);
        a.action = action;
        const hookRow = {
          t,
          tool: ev.tool_name ?? 'Tool',
          args: shortToolArgs(ev),
          status: 'running',
          uid: `${t}-${a.tools}`,
        };
        a.hooks.push(hookRow);
        a.pending_hooks.set(hookRow.uid, hookRow);
        // Some events deserve a journal trace too — keep it readable.
        if (
          ev.tool_name === 'Bash' ||
          ev.tool_name === 'Skill' ||
          ev.tool_name === 'Agent' ||
          ev.tool_name === 'SendMessage'
        ) {
          a.journal.push({ t, kind: 'msg', text: action });
        }
        break;
      }
      case 'tool-post': {
        a.tools_running = Math.max(0, a.tools_running - 1);
        // Mark the most recent matching pending hook as ok/err.
        // We don't have a tool_use_id field, so match on tool name + most-recent.
        let last = null;
        for (const h of a.hooks) {
          if (h.tool === (ev.tool_name ?? '') && h.status === 'running') last = h;
        }
        if (last) {
          last.status = ev.tool_response?.ok === false ? 'err' : 'ok';
          a.pending_hooks.delete(last.uid);
        }
        break;
      }
      case 'session-start':
        a.journal.push({ t, kind: 'system', text: 'Session started' });
        break;
      case 'session-end':
        a.stopped = true;
        a.journal.push({ t, kind: 'system', text: 'Session ended' });
        break;
      case 'subagent-stop': {
        // `subagent-stop` is reserved for TRUE termination of a sub-agent.
        // Transient idle (teammate pausing between turns) is routed through
        // the separate `teammate-idle` event wired via TeammateIdle in the
        // teammate's own frontmatter
        // (https://code.claude.com/docs/en/agent-teams.md#enforce-quality-gates-with-hooks).
        // Two source shapes, discriminated by hook_event_name:
        //   1. hook_event_name=SubagentStop with agent_id — parent's
        //      settings.json observing a child terminate. Routed to the
        //      parent's record (via isParentObservation). Journal entry only;
        //      parent itself is NOT stopped.
        //   2. hook_event_name=Stop (with or without agent_id) — the
        //      sub-agent's OWN frontmatter Stop firing. Terminal for that
        //      record.
        if (ev.hook_event_name === 'SubagentStop' && ev.agent_id) {
          a.journal.push({
            t, kind: 'system',
            text: `Teammate ${ev.agent_id.slice(0, 8)} terminated`,
          });
        } else {
          a.stopped = true;
          a.journal.push({ t, kind: 'system', text: 'Sub-agent stopped' });
        }
        break;
      }
      case 'teammate-idle': {
        // Transient: teammate is pausing between turns to wait for a
        // SendMessage. Don't mark stopped — when the next message arrives,
        // the teammate wakes up and resumes firing tool events.
        a.action = 'idle (waiting for message)';
        a.journal.push({ t, kind: 'system', text: 'Teammate idle' });
        break;
      }
      case 'user-prompt': {
        const msg = ev.message ?? ev.tool_input?.prompt ?? '';
        if (msg) {
          a.journal.push({
            t, kind: 'msg',
            text: `User: ${String(msg).slice(0, 240)}`,
          });
        }
        break;
      }
      case 'stop':
        // Stop event fires every time the model finishes a response — too
        // noisy for the journal, but useful as an idle marker.
        break;
      case 'notification':
        if (ev.message) a.journal.push({ t, kind: 'system', text: String(ev.message).slice(0, 200) });
        break;
      case 'pre-compact':
        a.journal.push({ t, kind: 'system', text: 'Context compacted' });
        break;
      default:
        break;
    }

    // Cap to keep memory + payload bounded.
    if (a.hooks.length > CONFIG.hookCapPerAgent) {
      a.hooks = clampList(a.hooks, CONFIG.hookCapPerAgent);
    }
    if (a.journal.length > CONFIG.journalCapPerAgent) {
      a.journal = clampList(a.journal, CONFIG.journalCapPerAgent);
    }
    return a;
  }

  function applySummary(rec) {
    if (!rec || !rec.session_id) return null;
    const t = tsMs(rec.ts);
    // Summaries carry session_id only — route them to the session-keyed record.
    // (Sub-agents identified by agent_id won't match summary records; that's
    //  fine — summaries currently only fire from the CEO main thread.)
    const a = getOrCreate({ session_id: rec.session_id, agent_id: null, agent_type: null }, t);
    if (a.started == null || t < a.started) a.started = t;
    if (a.last_seen == null || t > a.last_seen) a.last_seen = t;
    a.runtime = Math.max(0, Math.floor(((a.last_seen ?? t) - (a.started ?? t)) / 1000));
    if (rec.recipe && !a.role) {
      // recipe ≈ task type ("review", "post-merge-sweep", etc.) — keep as fallback.
      a.role = a.role ?? null;
    }
    if (rec.brief) {
      a.journal.push({
        t, kind: 'system',
        text: `Brief: ${rec.brief.slice(0, 240)}`,
      });
    }
    if (rec.path_chosen) {
      a.journal.push({
        t, kind: 'msg',
        text: rec.path_chosen.slice(0, 480),
      });
    }
    if (rec.outcome) {
      a.journal.push({
        t, kind: 'system',
        text: `Outcome: ${rec.outcome}`,
      });
    }
    if (rec.notes) {
      a.journal.push({
        t, kind: 'msg',
        text: rec.notes.slice(0, 480),
      });
    }
    a.stopped = true; // summaries are terminal
    if (a.journal.length > CONFIG.journalCapPerAgent) {
      a.journal = clampList(a.journal, CONFIG.journalCapPerAgent);
    }
    return a;
  }

  async function readAppended(filePath, fromOffset, carry) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return { offset: 0, carry: '', lines: [] };
      throw err;
    }
    let start = fromOffset;
    if (stat.size < fromOffset) {
      // File was truncated/rotated; restart from zero.
      start = 0;
      carry = '';
    }
    if (stat.size === start) return { offset: start, carry, lines: [] };
    const fh = await fs.open(filePath, 'r');
    try {
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      const text = carry + buf.toString('utf8');
      const newlineIdx = text.lastIndexOf('\n');
      let usable;
      let leftover;
      if (newlineIdx === -1) {
        usable = '';
        leftover = text;
      } else {
        usable = text.slice(0, newlineIdx);
        leftover = text.slice(newlineIdx + 1);
      }
      const lines = usable.split('\n').filter((l) => l.trim().length > 0);
      return { offset: stat.size, carry: leftover, lines };
    } finally {
      await fh.close();
    }
  }

  async function ingestHooks() {
    const r = await readAppended(project.hookFile, hookOffset, hookCarry);
    hookOffset = r.offset;
    hookCarry = r.carry;
    const touchedAgentIds = new Set();
    for (const line of r.lines) {
      const raw = safeJsonParse(line);
      if (!raw) continue;
      const ev = normalizeEvent(raw);
      const a = applyEvent(ev);
      if (a) touchedAgentIds.add(a.id);
    }
    return touchedAgentIds;
  }

  async function ingestSummaries() {
    const r = await readAppended(project.summaryFile, summaryOffset, summaryCarry);
    summaryOffset = r.offset;
    summaryCarry = r.carry;
    const touchedAgentIds = new Set();
    for (const line of r.lines) {
      const rec = safeJsonParse(line);
      if (!rec) continue;
      const a = applySummary(rec);
      if (a) touchedAgentIds.add(a.id);
    }
    return touchedAgentIds;
  }

  function snapshotAgents() {
    const now = Date.now();
    const out = [];
    for (const a of agents.values()) {
      const status = classifyAgent(a, now);
      out.push({
        id: a.id,
        project: a.project,
        session_id: a.session_id,
        agent_id: a.agent_id,
        name: a.name,
        subagent_type: a.subagent_type,
        role: a.role,
        team_name: a.team_name,
        parent_session: a.parent_session,
        status,
        action: a.action,
        started: a.started,
        last_seen: a.last_seen,
        runtime: a.runtime,
        tools: a.tools,
      });
    }
    return out;
  }

  function snapshotAgentDetail(agentId) {
    for (const a of agents.values()) {
      if (a.id === agentId) {
        return {
          ...a,
          status: classifyAgent(a),
          journal: [...a.journal],
          hooks: [...a.hooks],
          // Strip non-serialisable.
          pending_hooks: undefined,
        };
      }
    }
    return null;
  }

  return {
    project,
    async bootstrap() {
      hookOffset = 0;
      summaryOffset = 0;
      hookCarry = '';
      summaryCarry = '';
      agents.clear();
      pendingSpawns.length = 0;
      await ingestSummaries();
      await ingestHooks();
    },
    async refresh() {
      const touched = new Set([
        ...(await ingestSummaries()),
        ...(await ingestHooks()),
      ]);
      return touched;
    },
    snapshotAgents,
    snapshotAgentDetail,
    agentsMap: agents,
  };
}
