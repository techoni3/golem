import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { CONFIG } from './config.js';
import { createState } from './state.js';
import { roleMetaMap } from './roles.js';
import { pushBrief, pushInterrupt, pushHalt, pushControlEnvelope, channelHealth, listChannels } from './brief.js';
import { createChat } from './chat.js';
import { readNativeSessionPeek } from './native-session-peek.js';
import { openTrackerDb } from './tracker-db.js';
import { isChannelDeliveryReady, readChannels } from './channels.js';
import { applyGateVerdict, createGate } from './projects.js';
import { listIdeas, createIdea, popIdea, readIdea } from './ideas.js';
import { initDispatchDrainer } from './dispatch-queue.js';
import { registerSubstrateRoutes } from './substrate.js';
import { teamAssists } from './team-assist.js';
import { golemHome, dashboardJsonPath, journalDirFor, sessionsJsonPath } from '../../lib/golem-home.js';
import { createRole, deleteRole, getRole, listRoleCards, roleChangeBrief, roleMission, setSessionRole, updateRoleMeta, writeRoleCard } from '../../lib/session-role.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_SOURCE_ROOT = path.resolve(__dirname, '..', 'web');
const WEB_DIST_ROOT = path.resolve(__dirname, '..', 'dist');
const WEB_ROOT = fs.existsSync(path.join(WEB_DIST_ROOT, 'index.html')) ? WEB_DIST_ROOT : WEB_SOURCE_ROOT;
// The tracker genre templates live OUTSIDE dashboard/, in the substrate
// source tree at substrate/skills/tracker/templates/ (TKT-0574 — plugin/ is
// now a generated render of substrate/, not the SoT). Resolve the repo root
// two levels up from this file (dashboard/server/index.js → dashboard/ →
// repo root) and point at that dir. Used by GET /api/templates.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'substrate', 'skills', 'tracker', 'templates');

// Legacy markdown tracker columns (kept in /api/meta for API stability; the UI
// no longer renders the markdown board).
const TRACKER_COLUMNS = ['triage', 'open', 'in-progress', 'review', 'blocked', 'done'];

// ── Canonical project_id scheme (WS2) ───────────────────────────────────────
// Tickets, the projects list, and native sessions are reconciled on ONE id:
// the CONTRACT project_id `<slug>-<6hex>` derived from the absolute project
// root (see project-id.js → projectIdFor). It is what every project summary
// exposes as `project_id`, what native-sessions.js derives, and therefore what
// tickets must carry as `project_id`. The dashboard registry `id` (dir name like
// `sudoku`, or a hand-set external id like `trialroom-ai`) is NOT canonical and
// is deliberately NOT used to key tickets — it diverges across project kinds.
// `/api/tickets?project=` and `/api/sessions/dispatchable?project=` both expect
// this contract id. We tolerate a registry-`id` being passed by resolving it to
// the contract id via the projects list before querying (resolveProjectId).

/** Read the pid previously recorded by a dashboard instance, if any. */
function readPreviousDashboardPid() {
  const target = dashboardJsonPath();
  try {
    const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (doc && typeof doc.pid === 'number') return doc.pid;
  } catch {}
  return null;
}

/** Spawn lsof to find the pid listening on a TCP port. Falls back to fuser. */
function findListenerPid(port) {
  const lsof = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-FpcL'], { encoding: 'utf8' });
  if (lsof.error) {
    const fuser = spawnSync('fuser', [port + '/tcp'], { encoding: 'utf8' });
    if (fuser.error) {
      return { pid: null, error: `cannot identify process holding port ${port} (lsof/fuser unavailable)` };
    }
    const m = String(fuser.stdout).match(/\d+/);
    return { pid: m ? Number(m[0]) : null, error: null };
  }
  for (const line of String(lsof.stdout).split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      if (!Number.isNaN(pid)) return { pid, error: null };
    }
  }
  return { pid: null, error: `lsof found no LISTEN process on port ${port}` };
}

/** Return true if a process with this pid is still alive. */
function isProcessAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** Short sleep helper for polling during graceful shutdown waits. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Look up the command name of a process for clearer error messages. */
function getProcessComm(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return (result.stdout || '').trim() || 'unknown';
}

// TKT-0245: build a self-contained brief so the receiving session knows exactly
// what it's been handed and how to pick it up. Extracted from the inline
// construction in the dispatch handler so the drainer (dispatch-queue.js)
// produces byte-identical briefs — no format drift between the two delivery
// paths. `note` is an already-trimmed string or null.
// `workspace` is an optional directive ('worktree' | undefined) that appends
// a workspace setup block to the brief (GOL-316 §2.7).

function ticketSlug(title) {
  return String(title || 'ticket')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function workspaceBlock(ticket) {
  const id = ticket.display_id || ticket.id;
  const kind = ticket.kind === 'fix' ? 'fix' : 'feat';
  const slug = ticketSlug(ticket.title);
  const branch = `${kind}/${id.toLowerCase()}-${slug}`;
  const dir = `.worktrees/${id}-${slug}/`;
  return [
    '',
    '## Workspace: worktree',
    `Branch: \`${branch}\``,
    `Worktree dir: \`${dir}\``,
    '',
    '### Setup',
    '```bash',
    `git worktree add ${dir} -b ${branch} main`,
    `cp -Rc node_modules ${dir}node_modules`,
    `cp -Rc mcp/channel/node_modules ${dir}mcp/channel/node_modules`,
    '```',
    '',
    '### Rules',
    '- Build inside the worktree; commit conventional commits on the branch.',
    '- Rebase on main before handing off for review.',
    '- **Prohibited inside the worktree:** `golem sync`, restarting the dashboard, editing the main checkout, claiming shared runtimes (port 7420, docker stacks).',
    '- Self-contained checks only: unit tests, `node --check`, temp-DB scripts.',
    '',
    '### Hand-off',
    `- Closing brief MUST include \`branch: ${branch}\` line.`,
    '- Ticket → review when done; the orchestrator reconciles via `git merge --no-ff` on main.',
  ].join('\n');
}

function buildDispatchBrief(ticket, note, workspace, messageId = null) {
  if (ticket?.kind === 'spec') return buildSpecBrief(ticket, note, workspace, messageId);
  const id = ticket.display_id || ticket.id;
  let brief =
    `You've been assigned tracker ticket ${id}: "${ticket.title}" (project ${ticket.project_id}, kind ${ticket.kind}).\n\n` +
    `${note ? note + '\n\n' : ''}` +
    `Load it with the golem tracker tools (ticket_get ${id}) to read the full body, acceptance criteria, and comment thread, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete. ` +
    `If you have blocking questions, create a question-kind ticket in this project assigned to 'human'.` +
    (messageId ? `\n\nDispatch message_id: ${messageId}\nAcknowledge this dispatch first with ack({ kind: 'brief', summary: '<one sentence>', envelope_id: '${messageId}' }).` : '');
  if (workspace === 'worktree') brief += workspaceBlock(ticket);
  return brief;
}

function buildSpecBrief(ticket, note, workspace, messageId = null) {
  const id = ticket.display_id || ticket.id;
  const comments = (ticket.comments || []).filter((c) => c.dispatch_state === 'undispatched' || c.dispatch_state === 'dispatched');
  const children = ticket.children || [];
  const commentSection = comments.length
    ? comments.map((c, idx) => [
      `### Comment ${idx + 1}: ${c.id}`,
      `Author: ${c.author || 'unknown'} · state: ${c.dispatch_state}`,
      c.block_id ? `Block: ${c.block_id}` : null,
      c.quote ? `Quote: ${c.quote}` : null,
      '',
      c.body || '',
    ].filter((line) => line != null).join('\n')).join('\n\n')
    : 'No undispatched/dispatched comments.';
  const childSection = children.length
    ? children.map((c) => `- ${c.display_id || c.id}: ${c.title} — ${c.state}${c.wave ? ` — W${c.wave}` : ''}`).join('\n')
    : 'No child work items.';
  const lines = [
    `You've been assigned spec ticket ${id}: "${ticket.title}" (project ${ticket.project_id}).`,
    '',
    note || null,
    'This is a full-context spec dispatch. Re-read the spec, the active comment feedback, and child work-item summaries before proceeding.',
    '',
    `Spec: ${id}`,
    `State: ${ticket.state}`,
    '',
    '## Spec Body',
    ticket.body || '(empty)',
    '',
    '## Active Comments',
    commentSection,
    '',
    '## Child Work Items',
    childSection,
    '',
    `Load it with the golem tracker tools (ticket_get ${id}) to read the full body, comment thread, and links, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete.`,
    `If you have blocking questions, create a question-kind ticket in this project assigned to 'human'.`,
    messageId ? `Dispatch message_id: ${messageId}\nAcknowledge this dispatch first with ack({ kind: 'brief', summary: '<one sentence>', envelope_id: '${messageId}' }).` : null,
  ];
  if (workspace === 'worktree') lines.push(workspaceBlock(ticket));
  return lines.filter((line) => line != null).join('\n');
}

// GOL-423: a passive batch only rides an already-actionable delivery. Claiming
// or committing it must never make the dispatch/reply path fail; an unavailable
// buffer simply leaves the normal brief untouched for this opportunity.
function appendPassiveDelta(tracker, sessionId, brief) {
  try {
    const claim = tracker.claimPassiveDelta(sessionId);
    if (!claim?.lease_id || !claim?.batch?.body) return { brief, claim: null };
    return { brief: `${brief}\n\n${claim.batch.body}`, claim };
  } catch {
    return { brief, claim: null };
  }
}

function settlePassiveDelta(tracker, sessionId, claim, delivered) {
  if (!claim?.lease_id) return;
  try {
    if (delivered) tracker.commitPassiveDelta(sessionId, claim.lease_id);
    else tracker.releasePassiveDelta(sessionId, claim.lease_id);
  } catch {
    // The durable batch remains replayable after an interrupted settlement.
  }
}

function statusForHookEvent(type) {
  switch (type) {
    case 'session-start': return 'idle';
    case 'user-prompt': return 'busy';
    case 'stop': return 'idle';
    case 'session-end': return 'ended';
    default: return null;
  }
}

function updateSessionMaterializedStatusFromIngest(result) {
  const rows = Array.isArray(result?.events) ? result.events : [];
  if (!rows.length) return { updated: 0 };
  let doc;
  const target = sessionsJsonPath();
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return { updated: 0 };
  }
  if (!Array.isArray(doc.sessions)) doc.sessions = [];
  let changed = 0;
  for (const row of rows) {
    if (row?.duplicate || row?.class !== 'lifecycle') continue;
    const data = row.data || {};
    const hookEvent = data.hook_event || String(row.type || '').replace(/^hook_/, '').replace(/_/g, '-');
    const status = statusForHookEvent(hookEvent);
    const sessionId = data.session_id;
    if (!status || !sessionId) continue;
    const idx = doc.sessions.findIndex((s) => s?.session_id === sessionId);
    if (idx < 0) continue;
    const prev = doc.sessions[idx] || {};
    doc.sessions[idx] = {
      ...prev,
      status,
      status_updated_at: row.created_at,
      last_seen_at: row.created_at,
      ended_at: status === 'ended' ? row.created_at : (status === 'idle' || status === 'busy' ? null : prev.ended_at),
    };
    changed += 1;
  }
  if (!changed) return { updated: 0 };
  try {
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    return { updated: 0, error: String(err?.message ?? err) };
  }
  return { updated: changed };
}

function shellQuote(s) {
  return `'${String(s || '').replace(/'/g, `'\\''`)}'`;
}

function reviveCommandFor(session) {
  const cwd = session?.project_root || session?.cwd || REPO_ROOT;
  const name = session?.name || session?.session_id || '';
  return [
    `cd ${shellQuote(cwd)} && golemc`,
    name ? `# then run: /rename ${name}` : null,
  ].filter(Boolean).join('\n');
}

function firstClosingBriefLine(comment) {
  const text = String(comment?.body || '').replace(/<[^>]+>/g, ' ').trim();
  const section = text.split(/\n###\s+/).find((s) => /^What was done\b/i.test(s)) || text;
  const line = section.split('\n').map((l) => l.replace(/^[-*]\s+/, '').trim()).find((l) => l && !/^What was done\b/i.test(l));
  return line || 'Closing brief posted.';
}

function specRetroBody(tracker, spec) {
  const children = (spec.children || []).filter((child) => child.kind !== 'spec');
  const shipped = children.map((child) => {
    const full = tracker.getTicket(child.id);
    const closing = (full?.comments || []).reverse().find((c) => /closing brief/i.test(c.body || ''));
    return `- ${child.display_id || child.id}: ${child.title} - ${closing ? firstClosingBriefLine(closing) : 'No closing brief found.'}`;
  });
  return [
    '## What shipped',
    shipped.length ? shipped.join('\n') : '- No child work items found.',
    '',
    '## Lessons',
    '- ',
    '',
    '## Proposed doc deltas',
    '- CLAUDE.md: ',
    '- AGENTS.md: ',
    '- REPO-MAP.md: ',
  ].join('\n');
}

function handleSpecClosed(tracker, existing, ticket, actor = 'system') {
  if (!existing || !ticket || existing.kind !== 'spec' || ticket.kind !== 'spec' || existing.state === 'done' || ticket.state !== 'done') return null;
  const fresh = tracker.getTicket(ticket.id);
  if ((fresh.comments || []).some((c) => c.block_id === 'retro')) return null;

  const text = `Spec ${fresh.display_id || fresh.id} closed: ${fresh.title}`;
  const journalDir = journalDirFor(fresh.project_id);
  fs.mkdirSync(journalDir, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: 'milestone',
    session_id: actor,
    project_id: fresh.project_id,
    text,
  });
  fs.appendFileSync(path.join(journalDir, 'hook.jsonl'), `${line}\n`, 'utf8');

  const comment = tracker.addComment(fresh.id, {
    author: 'system:spec-close',
    body: specRetroBody(tracker, fresh),
    tag: 'note',
    status: 'open',
    block_id: 'retro',
  });
  return { ticket: tracker.getTicket(fresh.id), comment, milestone: JSON.parse(line) };
}

function ideaSpecBody(body) {
  return [
    '# Spec: Promoted idea',
    '',
    '## 1. Intent (raw thoughts, preserved)',
    '',
    String(body || '').trim() || '(empty idea)',
    '',
    '## 2. Behaviour',
    '',
    'Describe the promised user/system behaviour, then list checkable acceptance criteria that child work items can inherit.',
    '',
    '- [ ] <observable behaviour or outcome>',
    '- [ ] <observable behaviour or outcome>',
    '',
    '## 3. Decisions',
    '',
    'Record choices made while shaping the spec; include why and the road not taken.',
    '',
    '| Choice | Why | Road not taken |',
    '|--------|-----|----------------|',
    '| <decision> | <reason> | <rejected alternative> |',
    '',
    '## 4. Non-goals',
    '',
    'State what this spec explicitly will not do so fan-out does not grow hidden scope.',
    '',
    '- <out of scope>',
    '',
    '## 5. Open questions',
    '',
    'Track unresolved questions for the human/planner; answer or defer each before finalisation.',
    '',
    '- [ ] <question>',
    '',
    '> [!NOTE]',
    '> No fan-out section here. Child work items render below the spec body automatically.',
  ].join('\n');
}

function gateIdFromBlock(blockId) {
  const m = String(blockId || '').match(/^gate:(.+)$/);
  return m ? m[1] : null;
}

function gateRaiserFromComment(comment) {
  const author = String(comment?.author || '').trim();
  if (author && !['human', 'system'].includes(author)) return author;
  const m = String(comment?.body || '').match(/^Requested by:\s*(\S+)/mi);
  return m ? m[1] : null;
}

function gateVerdictFromText(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(cancel|cancelled|canceled)\b/.test(raw)) return 'cancel';
  if (/\b(deny|denied|reject|rejected)\b/.test(raw)) return 'deny';
  if (/\b(approve|approved|yes|proceed|go ahead|supplied|done)\b/.test(raw)) return 'approve';
  return null;
}

async function deliverControlEnvelope(tracker, {
  project_id = null,
  sender_id,
  recipient_session_id,
  kind,
  content,
  metadata = {},
  legacy,
} = {}) {
  const envelope = tracker.createControlEnvelope({
    project_id,
    sender_id,
    recipient_session_id,
    kind,
    payload: { content, ...metadata },
  });
  let delivery;
  try {
    delivery = await pushControlEnvelope({ envelope, content, legacy }, recipient_session_id);
    tracker.markEnvelopeDelivery(envelope.id, {
      error: delivery.ok ? null : (delivery.error || `status ${delivery.status}`),
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    tracker.markEnvelopeDelivery(envelope.id, { error: message });
    delivery = { ok: false, status: 0, error: message };
  }
  return { envelope, delivery };
}

async function notifyGateResolved(tracker, comment, patchBody) {
  const gateId = gateIdFromBlock(comment?.block_id);
  if (!gateId || comment?.status !== 'resolved') return null;
  const sessionId = gateRaiserFromComment(comment);
  if (!sessionId) return { ok: false, error: 'gate raiser missing', gate_id: gateId };
  const explicitText = String(patchBody || '').trim();
  const note = explicitText || `Gate ${gateId} resolved.`;
  const verdict = explicitText ? gateVerdictFromText(explicitText) : null;
  const content = verdict
    ? `GATE ${verdict.toUpperCase()} — ${gateId}\n\n${note}`
    : `Gate ${gateId} resolved.\n\n${note}`;
  const { envelope, delivery } = await deliverControlEnvelope(tracker, {
    project_id: comment?.project_id ?? null,
    sender_id: 'human:dashboard',
    recipient_session_id: sessionId,
    kind: 'gate_resolution',
    content,
    metadata: { gate_id: gateId, verdict: verdict || 'brief' },
    legacy: verdict
      ? { path: `/gates/${encodeURIComponent(gateId)}/${verdict}`, body: note }
      : { path: '/brief', body: content },
  });
  if (!delivery.ok) console.warn(`[gates] resolve notification for ${gateId} to ${sessionId} failed: ${delivery.error || delivery.status}`);
  return { ...delivery, envelope_id: envelope.id, gate_id: gateId, session_id: sessionId, verdict: verdict || 'brief' };
}

async function main() {
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const state = createState();
  // TKT-0107: tracker is opened BEFORE state.init() so the composite
  // last_activity_at signal in the sidebar can read maxTicketUpdatedAt.
  // (state.init(tracker) needs the tracker reference; previously init()
  // took no args and the tracker wasn't wired in.)
  // WS2: the dashboard is the SINGLE WRITER of the tracker DB. Open it once
  const chat = createChat();
  chat.start();

  // WS2: the dashboard is the SINGLE WRITER of the tracker DB. Open it once
  // here (it auto-inits / migrates). GOLEM_TRACKER_DB override flows through
  // openTrackerDb → defaultDbPath. Closed in shutdown() below.
  const tracker = openTrackerDb();
  tracker.recomputeAllCommentDispatchStates();

  // Load the dashboard state (projects, plans, milestones, channels). State
  // init does an initial rediscover that consumes the tracker reference for
  // per-project last-ticket-updated lookup. The auto-archive sweep (TKT-0105)
  // and the discoverProjects call (TKT-0107) both need it.
  await state.init(tracker);

  // Resolve a caller-supplied `project` query value to the canonical contract
  // project_id. Accepts either the contract id (passed straight through) OR a
  // dashboard registry id (e.g. `sudoku`, `trialroom-ai`) OR a unique human
  // project name, which we map to its project_id via the projects list.
  // Ambiguous names are rejected rather than silently selecting a workspace.
  // Unknown values pass through unchanged so a not-yet-discovered project
  // still filters correctly on its raw id.
  function resolveProjectId(value) {
    if (!value) return null;
    const requested = String(value).trim();
    if (!requested) return null;
    const projects = state.projects();
    for (const p of projects) {
      if (p.project_id === requested) return requested; // already canonical
      if (p.id === requested && p.project_id) return p.project_id; // registry id → contract id
    }
    const named = projects.filter((p) => p.name === requested && p.project_id);
    if (named.length === 1) return named[0].project_id;
    if (named.length > 1) {
      const ids = [...new Set(named.map((p) => p.project_id))];
      const error = new Error(`project name "${requested}" is ambiguous (${ids.join(', ')}); pass an exact project_id`);
      error.statusCode = 400;
      error.code = 'AMBIGUOUS_PROJECT_NAME';
      throw error;
    }
    return requested;
  }

  // WS2: all streams across every project (no all-streams helper on the DB,
  // and discovered projects may lag behind tickets an agent just created — so
  // read the table directly rather than iterating the projects list).
  function listAllStreams() {
    return tracker.raw().prepare('SELECT * FROM streams ORDER BY created_at ASC, id ASC').all();
  }

  function resolveTicketRef(ref) {
    if (!ref) return null;
    return tracker.getTicket(ref) || tracker.getTicketByDisplayId(ref);
  }

  function publicComment(comment, ticket) {
    return comment && ticket?.display_id ? { ...comment, ticket_id: ticket.display_id } : comment;
  }

  function resolveTicketIdField(ref) {
    if (ref == null || ref === '') return ref;
    const ticket = resolveTicketRef(ref);
    if (!ticket) throw new Error(`ticket ref '${ref}' not found`);
    return ticket.id;
  }

  function enforceAttribution(reply, body, field, context) {
    if (String(body?.[field] || '').trim()) return null;
    const message = `${context}: explicit ${field} is required for attribution`;
    if (CONFIG.attributionMode === 'reject') return reply.code(400).send({ error: message, attribution_mode: 'reject' });
    fastify.log.warn({ context, field, attribution_mode: CONFIG.attributionMode }, message);
    reply.header('X-Golem-Attribution-Warning', message);
    return null;
  }

  function deadSessionRevival(ticket, opts = {}) {
    const minAgeMinutes = Math.max(0, Number(opts.minAgeMinutes ?? 5) || 5);
    const pending = tracker.getPendingDispatchForTicket(ticket.id);
    if (!ticket || ticket.kind !== 'spec' || !pending) return { eligible: false, reason: 'not_applicable' };
    const ageMs = Date.now() - (Date.parse(pending.created_at || '') || Date.now());
    if (ageMs < minAgeMinutes * 60_000) {
      return { eligible: false, reason: 'too_new', min_age_minutes: minAgeMinutes, pending_dispatch: pending };
    }
    const sessionId = pending.session_id || ticket.assignee;
    const native = state.nativeSessions().find((s) => s.session_id === sessionId) || null;
    const channel = state.channels().find((c) => c.session_id === sessionId) || null;
    const offline = !native || native.alive === false || !channel;
    if (!offline) return { eligible: false, reason: 'session_live', min_age_minutes: minAgeMinutes, pending_dispatch: pending };
    const label = native?.name || pending.session_label || ticket.assignee_label || `session ${String(sessionId || '').slice(0, 8)}`;
    const project = state.project(ticket.project_id);
    const fallbackSession = { name: label, session_id: sessionId, project_root: project?.path || REPO_ROOT, cwd: project?.path || REPO_ROOT };
    return {
      eligible: true,
      reason: !native || native.alive === false ? 'session_offline' : 'channel_unreachable',
      min_age_minutes: minAgeMinutes,
      age_ms: ageMs,
      pending_dispatch: pending,
      session: native ? { ...native, label } : { ...fallbackSession, label, project_id: ticket.project_id },
      revive_command: reviveCommandFor(native || fallbackSession),
    };
  }

  const NORMALIZED_DELIVERY_REASONS = new Set([
    'ready', 'busy', 'waiting', 'missing_channel', 'endpoint_unhealthy', 'not_ready',
  ]);

  function deriveSessionDelivery(session, channel) {
    const channel_present = !!channel;
    const endpoint_health = channel?.endpoint_health
      ?? (session.fact_observed_at ? 'unreachable' : (session.endpoint_health ?? 'legacy'));
    const delivery_ready = isChannelDeliveryReady(channel);
    const endpointUnhealthy = endpoint_health === 'unreachable'
      || endpoint_health === 'unverified'
      || endpoint_health === 'unhealthy';
    const publishedReason = typeof channel?.delivery_reason === 'string'
      ? channel.delivery_reason
      : channel?.consumer_reason;
    const normalizedReason = NORMALIZED_DELIVERY_REASONS.has(publishedReason)
      ? publishedReason
      : null;
    const delivery_reason = delivery_ready ? 'ready'
      : !channel_present ? 'missing_channel'
      : endpointUnhealthy ? 'endpoint_unhealthy'
      : session.status === 'waiting' ? 'waiting'
      : session.status === 'busy' ? 'busy'
      : normalizedReason ?? 'not_ready';
    return {
      channel_present,
      endpoint_health,
      delivery_ready,
      delivery_reason,
      // Existing routing callers use reachable for immediate eligibility. Keep
      // that meaning while exposing endpoint presence separately above.
      reachable: delivery_ready,
    };
  }

  function hasAuthenticatedHealthyChannel(session) {
    return session.channel_present === true && session.endpoint_health === 'healthy';
  }

  function enrichSessionRows(rows, channels = []) {
    const channelById = new Map((channels || []).filter((c) => c.session_id).map((c) => [c.session_id, c]));
    const pendingBySession = tracker.countPendingDispatchesBySession();
    const unackedBySession = new Map();
    for (const warning of tracker.activeUnackedWarnings()) {
      const arr = unackedBySession.get(warning.session_id) ?? [];
      arr.push(warning);
      unackedBySession.set(warning.session_id, arr);
    }
    return (rows || []).map((s) => {
      const delivery = deriveSessionDelivery(s, channelById.get(s.session_id));
      return {
        ...s,
        role: s.role ?? null,
        harness: s.harness ?? 'claudecode',
        ...delivery,
        pending_count: pendingBySession.get(s.session_id) ?? 0,
        current_in_progress_ticket: tracker.currentInProgressTicketForSession(s.session_id),
        has_unacked_dispatch: (unackedBySession.get(s.session_id) ?? []).length > 0,
        active_unacked_dispatches: unackedBySession.get(s.session_id) ?? [],
        project_id: s.project_id ?? null,
      };
    });
  }

  function slimTicket(ticket) {
    if (!ticket) return null;
    return {
      id: ticket.id,
      display_id: ticket.display_id ?? null,
      title: ticket.title,
      kind: ticket.kind,
      state: ticket.state,
    };
  }

  function buildTeamRows(projectId, { channels = state.channels(), aliveOnly = false } = {}) {
    const wanted = resolveProjectId(projectId);
    const roles = roleMetaMap();
    return enrichSessionRows(state.nativeSessions(), channels)
      .filter((s) => (!aliveOnly || s.alive) && (!wanted || s.project_id === wanted))
      .map((s) => {
        const inProgress = tracker
          .listTickets({ project_id: wanted, assignee: s.session_id, state: 'in_progress' })
          .map(slimTicket)
          .filter(Boolean);
        const lastActive = s.updated_at ?? s.started_at ?? null;
        const roleMeta = s.role ? roles[s.role] ?? null : null;
        return {
          ...s,
          label: s.name || `session ${String(s.session_id ?? '').slice(0, 8)}`,
          role_meta: roleMeta,
          in_progress_tickets: inProgress,
          workload: {
            in_progress_tickets: inProgress,
            pending_count: s.pending_count ?? 0,
            last_active: lastActive,
          },
        };
      });
  }

  await fastify.register(websocket);
  await registerSubstrateRoutes(fastify);
  await fastify.register(fastifyStatic, {
    root: WEB_ROOT,
    prefix: '/',
    cacheControl: false,
    // Force browsers to revalidate every asset on each load. Without this the
    // browser will hold onto JSX/CSS via Last-Modified/ETag for the session
    // and dashboard edits won't show up without a hard refresh. The dashboard
    // is an internal-only dev surface — no point in any caching.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  });

  // SPA fallback (TKT-0146): client-side routes are path-based now
  // (/tickets/<id>, /project/<id>, /dashboard, …). A refresh or deep link on
  // such a path would otherwise 404 because the static plugin only serves real
  // files. For non-API GETs, serve index.html and let the router boot the right
  // view. API/websocket misses still get a real 404.
  fastify.setNotFoundHandler(async (req, reply) => {
    const url = (req.url || '').split('?')[0];
    if (url.startsWith('/api/') || url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (req.method !== 'GET') {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const idx = fs.readFileSync(path.join(WEB_ROOT, 'index.html'));
      reply.type('text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.send(idx);
    } catch (err) {
      req.log.error({ err }, 'SPA fallback: index.html missing');
      return reply.code(500).send({ error: 'index.html not found' });
    }
  });

  // ---- REST API ----

  fastify.get('/api/health', async () => ({
    ok: true,
    projects_root: CONFIG.projectsRoot,
    project_count: state.projects().length,
    server_time: new Date().toISOString(),
  }));

  fastify.get('/api/meta', async () => ({
    roles: roleMetaMap(),
    columns: TRACKER_COLUMNS,
    config: {
      projectsRoot: CONFIG.projectsRoot,
      ideasRoot: CONFIG.ideasRoot,
      golemRoot: CONFIG.golemRoot,
      channelUrl: CONFIG.channelUrl,
      agentActiveWindowMs: CONFIG.agentActiveWindowMs,
      agentIdleTimeoutMs: CONFIG.agentIdleTimeoutMs,
      ceoLiveWindowMs: CONFIG.ceoLiveWindowMs,
    },
  }));

  fastify.get('/api/projects', async () => state.projects());

  fastify.get('/api/workspaces', async () => state.workspaces());

  // WS2: fold the tracker tables into every snapshot so a fresh client renders
  // the board immediately (no extra round-trip). v4 snapshot carries projects,
  // native_sessions, channels, recent_milestones; the tracker DB adds tickets
  // and streams.
  function trackerSnapshot() {
    return {
      // The client owns the archived visibility toggle/search. Include those
      // rows in the canonical snapshot so toggling never depends on a refetch.
      tickets: tracker.listTickets({ includeArchived: true }),
      streams: listAllStreams(),
    };
  }

  fastify.get('/api/snapshot', async () => ({
    ...state.snapshot(),
    native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()),
    ...trackerSnapshot(),
    chat: chat.snapshot(),
  }));

  // GOL-425: compact, read-only inspection over durable envelope facts. These
  // routes expose dispatch roots rather than raw event rows; status/attention
  // are derived at query time from delivery, acknowledgement, child-envelope,
  // and dismissal facts.
  const COMMUNICATION_ENVELOPE_STATES = new Set([
    'needs_attention', 'in_flight', 'history', 'queued',
    'awaiting', 'pinged', 'failed', 'escalated', 'healthy',
  ]);
  // Public fact filters intentionally use stable categories. `delivery` also
  // covers root and protocol-child attempt/opportunity/error fact rows.
  const COMMUNICATION_ENVELOPE_FACTS = new Set([
    'assigned', 'queued', 'delivery', 'deadline', 'acknowledged',
    'ack_ping', 'escalation', 'reply', 'completion', 'dismissed',
  ]);

  function communicationQueryString(query, name) {
    if (query[name] == null) return null;
    if (typeof query[name] !== 'string' || !query[name].trim()) throw new Error(`${name} must be a non-empty string`);
    return query[name].trim();
  }

  function communicationTimestamp(query, name) {
    const value = communicationQueryString(query, name);
    if (value == null) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`${name} must be a parseable timestamp`);
    return new Date(ms).toISOString();
  }

  function communicationEnvelopeFilter(query = {}) {
    const ticketValue = communicationQueryString(query, 'ticket') || '';
    const ticket = ticketValue ? resolveTicketRef(ticketValue) : null;
    const projectValue = communicationQueryString(query, 'project');
    const sessionValue = communicationQueryString(query, 'session');
    const state = communicationQueryString(query, 'state');
    const fact = communicationQueryString(query, 'fact');
    if (state && !COMMUNICATION_ENVELOPE_STATES.has(state)) throw new Error(`state must be one of: ${[...COMMUNICATION_ENVELOPE_STATES].join(', ')}`);
    if (fact && !COMMUNICATION_ENVELOPE_FACTS.has(fact)) throw new Error(`fact must be one of: ${[...COMMUNICATION_ENVELOPE_FACTS].join(', ')}`);
    const from = communicationTimestamp(query, 'from');
    const to = communicationTimestamp(query, 'to');
    if (from && to && from > to) throw new Error('from must be less than or equal to to');
    let limit = null;
    if (query.limit != null) {
      if (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit)) throw new Error('limit must be an integer from 1 to 500');
      limit = Number(query.limit);
      if (!Number.isSafeInteger(limit) || limit > 500) throw new Error('limit must be an integer from 1 to 500');
    }
    return {
      ticket_id: ticket?.id ?? (ticketValue || null),
      project_id: projectValue ? (resolveProjectId(projectValue) || projectValue) : null,
      session_id: sessionValue,
      state,
      fact,
      from,
      to,
      limit,
    };
  }

  fastify.get('/api/communication-health', async (req, reply) => {
    try {
      return tracker.communicationHealth(communicationEnvelopeFilter(req.query ?? {}));
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/message-envelopes', async (req, reply) => {
    try {
      const filter = communicationEnvelopeFilter(req.query ?? {});
      const items = tracker.listEnvelopeViews(filter);
      return { items, total: items.length };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/message-envelopes/:id', async (req, reply) => {
    const item = tracker.getEnvelopeView(req.params.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    return item;
  });

  fastify.get('/api/chat', async () => chat.snapshot());

  // ---- Orchestrator intrusion proxy (dashboard → golem MCP channel server) ----

  // Accept either { brief: "..." } / { text: "..." } / raw string, or any
  // serialisable JSON the user wants to attach. We forward what we get.
  function extractBody(req) {
    const b = req.body;
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (typeof b.brief === 'string') return b.brief;
    if (typeof b.text === 'string') return b.text;
    return b;
  }

  function bodyToText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof body.brief === 'string') return body.brief;
    if (typeof body.text === 'string') return body.text;
    try { return JSON.stringify(body); } catch { return String(body); }
  }

  // Record the user/system message FIRST so the chat lane updates even if the
  // channel server is unreachable. On forward failure, emit a system note so
  // the user sees what went wrong instead of a silent vanish.
  function noteForwardFailure(label, result) {
    const detail = result?.error || `status ${result?.status ?? '?'}`;
    chat.record('system', 'error', `${label} not delivered — channel ${detail}. Is the CEO session running?`);
  }

  // session_id is taken from the body OR the ?session= query string. The
  // frontend always passes it through the body so a single brief can be
  // routed to a specific CEO; query string is for curl convenience.
  function extractSessionId(req) {
    const sid = (req.body && typeof req.body === 'object' && typeof req.body.session_id === 'string'
      ? req.body.session_id
      : null) ?? (typeof req.query?.session === 'string' ? req.query.session : null);
    return sid && sid.trim() ? sid.trim() : null;
  }

  function requirePassiveCaller(req, reply, sessionId) {
    const caller = typeof req.headers['x-golem-caller-session'] === 'string'
      ? req.headers['x-golem-caller-session'].trim()
      : '';
    if (caller && caller === sessionId) return true;
    reply.code(403).send({ error: 'passive delta caller does not match intended session' });
    return false;
  }

  fastify.post('/api/brief', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('user', 'brief', bodyToText(body), sessionId ? { session_id: sessionId } : {});
    const result = await pushBrief(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('brief', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  fastify.post('/api/messages/notify', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.sender_id || !b.session_id) return reply.code(400).send({ error: 'notification sender_id and session_id are required' });
    try {
      const passive = appendPassiveDelta(tracker, b.session_id, String(b.text || ''));
      let passiveCommitted = false;
      try {
        const result = await deliverControlEnvelope(tracker, {
          project_id: b.project_id ?? null,
          sender_id: b.sender_id,
          recipient_session_id: b.session_id,
          kind: 'session_notify',
          content: passive.brief,
          metadata: { notification_text: String(b.text || '') },
          legacy: { path: '/brief', body: passive.brief },
        });
        // Decide from the delivery opportunity before durable bookkeeping: a
        // bookkeeping failure must not replay context that already reached it.
        passiveCommitted = !!result.delivery?.ok;
        return { ok: !!result.delivery?.ok, envelope_id: result.envelope.id, delivery: result.delivery };
      } finally {
        settlePassiveDelta(tracker, b.session_id, passive.claim, passiveCommitted);
      }
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });
  fastify.post('/api/messages/control', async (req, reply) => {
    const b = req.body ?? {};
    const legacy = b.legacy && typeof b.legacy === 'object' ? b.legacy : null;
    const permittedLegacyPaths = new Set(['/brief', '/consult', '/consult/reply']);
    const gatePath = typeof legacy?.path === 'string'
      && /^\/gates\/[A-Za-z0-9._-]+\/(approve|deny|cancel)$/.test(legacy.path);
    if (!legacy || (typeof legacy.path !== 'string') || (!permittedLegacyPaths.has(legacy.path) && !gatePath)) {
      return reply.code(400).send({ error: 'control delivery requires a supported legacy route' });
    }
    try {
      const result = await deliverControlEnvelope(tracker, {
        project_id: b.project_id ?? null,
        sender_id: b.sender_id,
        recipient_session_id: b.session_id,
        kind: b.kind,
        content: String(b.content || ''),
        metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
        legacy: { path: legacy.path, body: legacy.body },
      });
      return { ok: !!result.delivery?.ok, envelope_id: result.envelope.id, delivery: result.delivery };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });
  fastify.post('/api/interrupt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('user', 'interrupt', bodyToText(body), sessionId ? { session_id: sessionId } : {});
    const result = await pushInterrupt(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('interrupt', result);
      return reply.code(result.status || 502).send(result);
    }
    return result;
  });
  fastify.post('/api/halt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('system', 'halt', bodyToText(body) || 'halt requested', sessionId ? { session_id: sessionId } : {});
    const result = await pushHalt(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('halt', result);
      return reply.code(result.status || 502).send(result);
    }
    return result;
  });
  // v4: brief / interrupt / halt are delivered over per-session channels.
  // Gate verdicts (v3 docs/agent-notes/gates/ flow) were removed in TKT-0009.
  fastify.get('/api/channel/health', async (req) => channelHealth(typeof req.query?.session === 'string' ? req.query.session : null));
  fastify.get('/api/channels', async () => listChannels());

  fastify.get('/api/projects/:id', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return state
      .projects()
      .find((x) => x.id === req.params.id);
  });

  // v4: PLAN.md progress for a single project. Returns {total, done, items}
  // (+ title). 404 if the project is unknown; {total:0,...} if it has no plan.
  fastify.get('/api/projects/:id/plan', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const plan = state.projectPlan(req.params.id);
    if (!plan) return { title: null, total: 0, done: 0, items: [] };
    return plan;
  });

  // TKT-0194: apply a human verdict to a gate (approve | deny | cancel).
  // Writes the new status to the gate file and returns the new state. The
  // dashboard refreshes the projects list (which re-reads gates on the
  // next request) to show the updated verdict.
  fastify.post('/api/projects/:id/gates/:gateId/:decision', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'project_not_found' });
    try {
      const result = await applyGateVerdict(p.gatesDir, req.params.gateId, req.params.decision);
      return result;
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // GOL-171: new gates fold into spec comments when a spec is identifiable.
  // Legacy gate-file verdicts remain readable/applicable for files already on disk.
  fastify.post('/api/projects/:id/gates', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'project_not_found' });
    try {
      console.warn(`[gates] deprecated gate-write API hit for project ${p.project_id || p.id}; routing to spec comment gate`);
      const result = await createGate({ tracker, project: p, gate: req.body ?? {} });
      if (result.mode === 'comment') {
        broadcastWS({ type: 'ticket-comment', ticket_id: result.ticket.id, comment: result.comment });
        broadcastWS({ type: 'ticket-updated', ticket: result.ticket });
        return reply.code(201).send(result);
      }
      return reply.code(201).send(result);
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // v4: all native Claude Code sessions on this machine (merged CLI + registry,
  // pid-checked). Already inside /api/snapshot as native_sessions[]; this is a
  // convenience route + the polling target for any external scripting.
  fastify.get('/api/native-sessions', async () => enrichSessionRows(state.nativeSessions(), state.channels()));

  // v4 (fix round 2, defect 1): per-session peek for the native-session drawer.
  // Returns { session, events, milestones, transcript_path, note } where events
  // are the recent central-journal hook lines filtered by this session_id.
  fastify.get('/api/native-sessions/:sessionId/peek', async (req) => {
    const sessionId = req.params.sessionId;
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    return readNativeSessionPeek(sessionId, session);
  });

  // ---- WS2: tracker REST (the dashboard is the SINGLE WRITER) ----
  // Every mutation persists via `tracker` then broadcasts a WS delta.

  // GET /api/tickets — consolidated/filtered board feed. No `project` = all
  // projects. The DB filter key is `project_id`; the REST param is `project`.
  fastify.get('/api/tickets', async (req) => {
    const q = req.query ?? {};
    const filter = {};
    if (q.project != null) filter.project_id = resolveProjectId(q.project);
    if (q.state != null) filter.state = q.state;
    if (q.assignee != null) filter.assignee = q.assignee;
    if (q.kind != null) filter.kind = q.kind;
    // TKT-0284: negative-kind filter (Tracker excludes specs) + parent_id
    // filter (drawer's children panel). Both mirror the existing pattern —
    // cheap WHERE additions, no new entity.
    if (q.excludeKind != null) filter.exclude_kind = q.excludeKind;
    if (q.parent != null) filter.parent_id = resolveTicketIdField(q.parent);
    if (q.stream != null) filter.stream_id = q.stream;
    if (q.includeArchived != null) {
      filter.includeArchived = q.includeArchived === 'true' || q.includeArchived === true || q.includeArchived === '1';
    }
    return tracker.listTickets(filter);
  });

  // TKT-0284: GET /api/tickets/search — content search across title + body.
  // Params: project (required contract project_id), kind (optional), q (≥2 chars).
  // Returns an array of { id, title, kind, state, updated_at, snippet,
  // title_match, match_start, match_len }. 400 on missing/short q.
  // LIKE-based v1; contract stable for an FTS5 swap if spec volume warrants it.
  fastify.get('/api/tickets/search', async (req, reply) => {
    const q = req.query ?? {};
    const projectId = q.project != null ? resolveProjectId(q.project) : null;
    const qq = q.q != null ? String(q.q) : '';
    if (qq.length < 2) {
      return reply.code(400).send({ error: 'q must be at least 2 characters' });
    }
    const filter = { project_id: projectId, q: qq };
    if (q.kind != null) filter.kind = q.kind;
    return tracker.searchTickets(filter);
  });

  // POST /api/tickets — create. 400 on validation error.
  fastify.post('/api/tickets', async (req, reply) => {
    const b = req.body ?? {};
    const attribution = enforceAttribution(reply, b, 'created_by', 'createTicket');
    if (attribution) return attribution;
    try {
      const ticket = tracker.createTicket({
        project_id: b.project_id,
        kind: b.kind,
        title: b.title,
        body: b.body,
        priority: b.priority,
        labels: b.labels,
        stream_id: b.stream_id,
        parent_id: resolveTicketIdField(b.parent_id),
        wave: b.wave,
        assignee: b.assignee,
        created_by: b.created_by,
      });
      broadcastWS({ type: 'ticket-created', ticket });
      return reply.code(201).send(ticket);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/tickets/:id — ticket (+ comments/links from getTicket) plus its
  // event history. 404 if unknown.
  fastify.get('/api/tickets/:id', async (req, reply) => {
    const ticket = resolveTicketRef(req.params.id);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    return { ...ticket, events: tracker.listEvents({ ticket_id: ticket.id }) };
  });

  // PATCH /api/tickets/:id — partial update. 404 if missing, 400 on invalid.
  fastify.patch('/api/tickets/:id', async (req, reply) => {
    const existing = resolveTicketRef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    try {
      const patch = { ...(req.body ?? {}) };
      const attribution = enforceAttribution(reply, patch, 'actor', 'updateTicket');
      if (attribution) return attribution;
      if (Object.prototype.hasOwnProperty.call(patch, 'parent_id')) patch.parent_id = resolveTicketIdField(patch.parent_id);
      const ticket = tracker.updateTicket(existing.id, patch);
      const closeResult = handleSpecClosed(tracker, existing, ticket, patch.actor || 'human');
      if (closeResult) {
        broadcastWS({ type: 'ticket-comment', ticket_id: closeResult.ticket.id, comment: closeResult.comment });
        broadcastWS({ type: 'ticket-updated', ticket: closeResult.ticket });
        return closeResult.ticket;
      }
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // GOL-314: explicit phase-machine transition endpoint. State is derived by
  // the tracker DB from the target phase; legacy PATCH {state} stays supported.
  fastify.post('/api/tickets/:id/transition', async (req, reply) => {
    const existing = resolveTicketRef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    try {
      const patch = { ...(req.body ?? {}) };
      const attribution = enforceAttribution(reply, patch, 'actor', 'transitionTicket');
      if (attribution) return attribution;
      const ticket = tracker.transitionTicket(existing.id, patch);
      const closeResult = handleSpecClosed(tracker, existing, ticket, patch.actor || 'human');
      if (closeResult) {
        broadcastWS({ type: 'ticket-comment', ticket_id: closeResult.ticket.id, comment: closeResult.comment });
        broadcastWS({ type: 'ticket-updated', ticket: closeResult.ticket });
        return closeResult.ticket;
      }
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // TKT-0105: POST /api/tickets/:id/move — atomic state + rank change used by
  // drag-and-drop. Body: { state, before_id?, after_id?, actor? }. The endpoint
  // computes the new rank from the neighbour tickets (midpoint if both given,
  // otherwise appends to the target state). Replaces the old "PATCH with
  // {state}" path for drag operations (Phase B tracker-board.jsx still calls
  // PATCH; follow-up ticket will switch it to /move).
  fastify.post('/api/tickets/:id/move', async (req, reply) => {
    const existing = resolveTicketRef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    try {
      const patch = { ...(req.body ?? {}) };
      const attribution = enforceAttribution(reply, patch, 'actor', 'moveTicket');
      if (attribution) return attribution;
      if (Object.prototype.hasOwnProperty.call(patch, 'before_id')) patch.before_id = resolveTicketIdField(patch.before_id);
      if (Object.prototype.hasOwnProperty.call(patch, 'after_id')) patch.after_id = resolveTicketIdField(patch.after_id);
      const ticket = tracker.moveTicket(existing.id, patch);
      const closeResult = handleSpecClosed(tracker, existing, ticket, patch.actor || 'human');
      if (closeResult) {
        broadcastWS({ type: 'ticket-comment', ticket_id: closeResult.ticket.id, comment: closeResult.comment });
        broadcastWS({ type: 'ticket-updated', ticket: closeResult.ticket });
        return closeResult.ticket;
      }
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // TKT-0105: POST /api/tickets/auto-archive/sweep — manual trigger for the
  // 14-day done → archived sweep. Returns the list of archived ticket ids.
  // The same sweep runs automatically every 6 hours (see setInterval below).
  fastify.post('/api/tickets/auto-archive/sweep', async (req) => {
    const ids = runAutoArchiveSweep();
    if (ids.length > 0) {
      broadcastWS({ type: 'tickets-batch-archived', ids });
    }
    return { archived: ids.length, ids };
  });

  // TKT-0106: ticket asset upload. Validates MIME, size, and filename; stores
  // content-addressed under CONFIG.assetsDir; returns the public URL.
  fastify.post('/api/ticket-assets', async (req, reply) => {
    const b = req.body ?? {};
    const { filename, mime, base64 } = b;
    if (!filename || typeof filename !== 'string') return reply.code(400).send({ error: 'filename required' });
    if (!mime || !CONFIG.assetAllowedMime.includes(mime)) {
      return reply.code(400).send({ error: `mime must be one of ${CONFIG.assetAllowedMime.join(', ')}` });
    }
    if (typeof base64 !== 'string' || !base64) return reply.code(400).send({ error: 'base64 required' });
    // Decode + size check (raw bytes, NOT the base64 string length).
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) return reply.code(400).send({ error: 'empty payload' });
    if (buf.length > CONFIG.assetMaxBytes) {
      return reply.code(413).send({ error: `payload too large (${buf.length} > ${CONFIG.assetMaxBytes})` });
    }
    // Sanitise filename to extension (rest ignored). Map mime → ext.
    const ext = ({
      'image/png':  'png',
      'image/jpeg': 'jpg',
      'image/gif':  'gif',
      'image/webp': 'webp',
    })[mime];
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    fs.mkdirSync(CONFIG.assetsDir, { recursive: true });
    const relPath = `${hash}.${ext}`;
    const fullPath = path.join(CONFIG.assetsDir, relPath);
    if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, buf);
    return { url: `/api/ticket-assets/${relPath}`, filename, mime, size: buf.length };
  });

  // TKT-0106: serve a content-addressed asset. Reject anything that doesn't
  // match the hash.ext pattern (defends against ../etc/passwd etc.).
  fastify.get('/api/ticket-assets/:name', async (req, reply) => {
    const name = req.params.name;
    if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name)) {
      return reply.code(400).send({ error: 'invalid asset name' });
    }
    const fullPath = path.join(CONFIG.assetsDir, name);
    if (!fullPath.startsWith(CONFIG.assetsDir + path.sep) && fullPath !== CONFIG.assetsDir) {
      return reply.code(400).send({ error: 'path traversal' });
    }
    if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'not_found' });
    const ext = name.split('.').pop();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext];
    const stream = fs.createReadStream(fullPath);
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable'); // hash-based, safe to cache forever
    return reply.send(stream);
  });

  // POST /api/tickets/:id/comments — add a comment. Broadcasts both the comment
  // delta AND a ticket-updated (addComment bumps the ticket's updated_at).
  // POST /api/tickets/:id/comments — add a comment (plain or inline anchored).
  // Body: { author, body, quote?, prefix?, suffix?, section?, section_id?, tag?, status?, parent_id?, block_id? }
  fastify.post('/api/tickets/:id/comments', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    const attribution = enforceAttribution(reply, b, 'author', 'addComment');
    if (attribution) return attribution;
    try {
      const comment = tracker.addComment(id, {
        author: b.author,
        body: b.body,
        quote: b.quote,
        prefix: b.prefix,
        suffix: b.suffix,
        section: b.section,
        section_id: b.section_id,
        tag: b.tag,
        status: b.status,
        parent_id: b.parent_id,
        block_id: b.block_id,
      });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) {
        broadcastWS({ type: 'ticket-updated', ticket });
        for (const c of ticket.comments || []) broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment: c });
      }
      return reply.code(201).send(publicComment(comment, ticketRef));
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // PATCH /api/tickets/:id/comments/:cid — update a comment (status, tag, body).
  fastify.patch('/api/tickets/:id/comments/:cid', async (req, reply) => {
    const { cid } = req.params;
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      // TKT-0244: only include keys actually present on the request body, so a
      // PATCH {status:'resolved'} (Resolve/Reopen/tag-change/block_id-change)
      // doesn't write body=undefined → toMarkdownBody(undefined)='' and wipe
      // the comment's text + de-anchor its block_id. An explicit {body:''} still
      // clears intentionally (it's present → included → toMarkdownBody('')='').
      const patch = Object.fromEntries(
        ['body', 'tag', 'status', 'block_id'].filter((k) => k in b).map((k) => [k, b[k]])
      );
      const before = tracker.getComment(cid);
      const comment = tracker.updateComment(id, cid, patch);
      if (before?.status !== 'resolved' && comment.status === 'resolved' && gateIdFromBlock(comment.block_id)) {
        await notifyGateResolved(tracker, comment, patch.body || b.resolution || b.verdict || '');
      }
      broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return publicComment(comment, ticketRef);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/comments/:cid/reply — add a reply to a comment.
  fastify.post('/api/tickets/:id/comments/:cid/reply', async (req, reply) => {
    const { cid } = req.params;
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    const attribution = enforceAttribution(reply, b, 'author', 'replyComment');
    if (attribution) return attribution;
    try {
      const comment = tracker.addComment(id, {
        author: b.author,
        body: b.body,
        parent_id: cid,
        tag: 'note',
      });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) {
        broadcastWS({ type: 'ticket-updated', ticket });
        for (const c of ticket.comments || []) broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment: c });
      }
      return reply.code(201).send(publicComment(comment, ticketRef));
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  function commentDispatchTarget(ticket, body = {}) {
    const explicit = typeof body.session_id === 'string' && body.session_id.trim() ? body.session_id.trim() : null;
    if (explicit) return explicit;
    const assignee = typeof ticket?.assignee === 'string' && ticket.assignee.trim() ? ticket.assignee.trim() : null;
    return assignee && assignee !== 'human' ? assignee : null;
  }

  function commentDispatchCoveredBySubscription(ticket, sessionId) {
    if (!ticket || !sessionId) return false;
    const topic = `ticket/${ticket.display_id || ticket.id}`;
    return tracker.listSubscriptions({ session_id: sessionId }).some((sub) => {
      if (sub.status !== 'active' || sub.topic !== topic) return false;
      const classes = Array.isArray(sub.classes_filter) ? sub.classes_filter : [];
      return classes.includes('tracker');
    });
  }

  function commentBrief(ticket, comments, { batchId = null } = {}) {
    const list = Array.isArray(comments) ? comments : [comments];
    const label = ticket?.display_id || ticket?.id;
    const title = ticket?.title || ticket?.id || 'ticket';
    const lines = [
      `Comment dispatch for ${label}: ${title}`,
      '',
      'You have been sent human comment feedback on this spec. Re-read the ticket and address the dispatched comment(s).',
      '',
      batchId ? `Batch id: ${batchId}` : null,
      `Ticket: ${label}`,
      '',
      ...list.flatMap((comment, idx) => [
        `## Comment ${idx + 1}: ${comment.id}`,
        comment.block_id ? `Block: ${comment.block_id}` : null,
        comment.quote ? `Quote: ${comment.quote}` : null,
        '',
        comment.body || '',
        '',
      ]),
      'Use the tracker ticket tools or dashboard to reply on the same anchored block/comment so the dispatch flips to addressed.',
    ].filter((line) => line != null);
    return lines.join('\n');
  }

  async function deliverCommentDispatch(ticket, comments, sessionId, { batchId = null } = {}) {
    const brief = commentBrief(ticket, comments, { batchId });
    let channelResult = null;
    try {
      channelResult = await pushBrief(brief, sessionId);
    } catch (err) {
      channelResult = { ok: false, error: String(err?.message ?? err) };
    }
    if (channelResult?.ok) {
      chat.record('user', 'brief', brief, { session_id: sessionId });
      tracker.markCommentDispatchesDeliveredForTicket(ticket.id, sessionId);
    } else {
      const detail = channelResult?.error || `status ${channelResult?.status ?? '?'}`;
      chat.record('system', 'error', `comment dispatch of ${ticket.id} to ${sessionId} — channel ${detail}`);
    }
    const updated = tracker.getTicket(ticket.id);
    if (updated) {
      broadcastWS({ type: 'ticket-updated', ticket: updated });
      for (const comment of updated.comments || []) {
        broadcastWS({ type: 'ticket-comment-updated', ticket_id: updated.id, comment });
      }
    }
    return { channel: channelResult, ticket: updated };
  }

  // POST /api/comments/:id/dispatch — enqueue and deliver one comment as a
  // mini-brief to the spec's assigned session (or explicit fallback session_id).
  fastify.post('/api/comments/:cid/dispatch', async (req, reply) => {
    const cid = req.params.cid;
    const b = req.body ?? {};
    try {
      const comment = tracker.getComment(cid);
      if (!comment) return reply.code(404).send({ error: 'comment_not_found' });
      const ticket = tracker.getTicket(comment.ticket_id);
      if (!ticket) return reply.code(404).send({ error: 'ticket_not_found' });
      if (ticket.kind !== 'spec') return reply.code(400).send({ error: 'comment dispatch is only available for spec tickets' });
      const sessionId = commentDispatchTarget(ticket, b);
      if (!sessionId) return reply.code(400).send({ error: 'session_id is required when the spec has no session assignee' });
      const dispatch = tracker.enqueueCommentDispatch(comment, sessionId);
      if (commentDispatchCoveredBySubscription(ticket, sessionId)) {
        return { ok: true, dispatch, delivery: 'subscription', ticket: tracker.getTicket(ticket.id) };
      }
      const delivered = await deliverCommentDispatch(ticket, comment, sessionId);
      return { ok: true, dispatch, ...delivered };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/comments/batch-dispatch — enqueue all undispatched
  // comments on a spec using one shared batch_id and deliver one combined brief.
  fastify.post('/api/tickets/:id/comments/batch-dispatch', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      const ticket = ticketRef;
      if (!ticket) return reply.code(404).send({ error: 'not_found' });
      if (ticket.kind !== 'spec') return reply.code(400).send({ error: 'comment dispatch is only available for spec tickets' });
      const sessionId = commentDispatchTarget(ticket, b);
      if (!sessionId) return reply.code(400).send({ error: 'session_id is required when the spec has no session assignee' });
      const comments = tracker.listUndispatchedCommentsForSpec(id);
      if (comments.length === 0) return { ok: true, batch_id: null, dispatches: [], ticket };
      const batch = tracker.enqueueCommentDispatchBatch(id, sessionId);
      if (commentDispatchCoveredBySubscription(ticket, sessionId)) {
        return { ok: true, ...batch, delivery: 'subscription', ticket: tracker.getTicket(ticket.id) };
      }
      const delivered = await deliverCommentDispatch(ticket, comments, sessionId, { batchId: batch.batch_id });
      return { ok: true, ...batch, ...delivered };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  fastify.post('/api/tickets/:id/unacked/:deliveryEventId/dismiss', async (req, reply) => {
    const { deliveryEventId } = req.params;
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const actor = req.body?.actor || 'human:dashboard';
    try {
      const event = tracker.dismissUnackedDispatchWarning(id, deliveryEventId, { actor });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      broadcastWS({ type: 'communication-health-updated' });
      return event;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/links — add a link from this ticket. Re-fetch + send
  // the from-ticket as a ticket-updated delta.
  fastify.post('/api/tickets/:id/links', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      const toTicket = resolveTicketIdField(b.to_ticket);
      tracker.addLink(id, toTicket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send({ from_ticket: ticketRef.display_id, to_ticket: resolveTicketRef(toTicket)?.display_id || toTicket, type: b.type });
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // DELETE /api/tickets/:id/links — remove a link. Re-fetch + send the
  // from-ticket as a ticket-updated delta.
  fastify.delete('/api/tickets/:id/links', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      const toTicket = resolveTicketIdField(b.to_ticket);
      const result = tracker.removeLink(id, toTicket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  async function pushDispatchRevoked(ticket, previousSessionId, reason = 'dispatch revoked') {
    if (!ticket || !previousSessionId) return null;
    const label = ticket.display_id || ticket.id;
    const body = `Dispatch revoked for ${label}: ${ticket.title || ''}\n\nReason: ${reason}\n\nStand down unless you receive a new dispatch.`;
    let result = null;
    try {
      result = await pushBrief(body, previousSessionId);
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    }
    if (result?.ok) chat.record('system', 'dispatch_revoked', body, { session_id: previousSessionId, ticket_id: ticket.id });
    else chat.record('system', 'error', `dispatch_revoked for ${label} to ${previousSessionId} not delivered — ${result?.error || result?.status || 'unknown error'}`);
    return result;
  }

  fastify.get('/api/tickets/:id/revival', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const minutes = req.query?.min_age_minutes ?? req.query?.minAgeMinutes;
    return deadSessionRevival(ticketRef, { minAgeMinutes: minutes });
  });

  fastify.post('/api/tickets/:id/revival/redispatch', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const b = req.body ?? {};
    const sessionId = typeof b.session_id === 'string' && b.session_id.trim() ? b.session_id.trim() : null;
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const revival = deadSessionRevival(ticketRef, { minAgeMinutes: b.min_age_minutes ?? b.minAgeMinutes });
    if (!revival.eligible) return reply.code(409).send({ error: `revival_not_eligible:${revival.reason}`, revival });
    const live = state.nativeSessions().find((s) => s.session_id === sessionId);
    const hasChannel = state.channels().some((c) => c.session_id === sessionId && isChannelDeliveryReady(c));
    if (!live || !live.alive || !hasChannel) return reply.code(400).send({ error: 'target session is not live/reachable' });
    try {
      if (revival.pending_dispatch?.id) {
        const cancelled = tracker.cancelQueuedDispatch(revival.pending_dispatch.id, { actor: 'human:revival' });
        await pushDispatchRevoked(ticketRef, cancelled.session_id, 'revival redispatch cancelled queued dispatch');
      }
      const assigned = tracker.setDispatched(ticketRef.id, { session_id: sessionId, actor: 'human:revival' });
      if (assigned.revoked_session_id) await pushDispatchRevoked(assigned, assigned.revoked_session_id, 'redispatched during revival');
      const updated = tracker.getTicket(ticketRef.id);
      const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : 'Revival re-dispatch from dead-session warning.';
      const briefString = buildDispatchBrief(updated, note);
      let channelResult = null;
      try {
        channelResult = await pushBrief(briefString, sessionId);
      } catch (err) {
        channelResult = { ok: false, error: String(err?.message ?? err) };
      }
      if (channelResult?.ok) chat.record('user', 'brief', briefString, { session_id: sessionId });
      tracker.markDispatchDeliveryAttempted(ticketRef.id, {
        session_id: sessionId,
        actor: 'human:revival',
        error: channelResult?.ok ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`),
      });
      const ticket = tracker.getTicket(ticketRef.id);
      broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'dispatch-queue-updated' });
      return { ok: true, ticket, channel: channelResult };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/dispatch — assign a ticket to a live native session
  // and push it a self-contained brief. The response reports the actual
  // channel attempt separately from the durable assignment/envelope.
  //
  // Durable-first (mirrors the gate handler): setDispatched flips assignee +
  // dispatched_to + dispatched_at and records a `dispatched` event BEFORE we
  // touch the channel. Assignment is durable; an unreachable channel is a
  // failed delivery, not a successful dispatch.
  //
  // TKT-0245: `mode` ('now' | 'when_idle', default 'now'). 'when_idle' queues
  // the dispatch until the target session is idle (the drainer delivers it
  // then); if the target is already idle it falls through to the immediate
  // 'now' path. A bare POST (no mode) behaves exactly as before — the default
  // never changes, so existing MCP calls and older UIs are untouched.
  fastify.post('/api/tickets/:id/dispatch', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    const sessionId = typeof b.session_id === 'string' && b.session_id.trim() ? b.session_id.trim() : null;
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
    const senderId = typeof b.sender_id === 'string' && b.sender_id.trim() ? b.sender_id.trim() : null;
    const mode = typeof b.mode === 'string' ? b.mode : 'now';
    const workspace = typeof b.workspace === 'string' && b.workspace.trim() ? b.workspace.trim() : undefined;
    if (mode !== 'now' && mode !== 'when_idle') {
      return reply.code(400).send({ error: `mode must be 'now' or 'when_idle' (got '${mode}')` });
    }

    const existing = ticketRef;
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const nativeTarget = state.nativeSessions().find((s) => s.session_id === sessionId);
    const isPi = nativeTarget?.harness === 'pi';

    // 'when_idle': queue for delivery on idle unless the target is already idle
    // (in which case fall through to the immediate 'now' path — no queue row).
    if (mode === 'when_idle' || isPi) {
      const target = nativeTarget;
      // TKT-0369: only fall through to the immediate path when the target is
      // idle AND actually reachable — an idle session with a dead channel MCP
      // must queue (the row delivers when the channel re-registers), not burn
      // on an immediate push that cannot succeed.
      let hasChannel = false;
      try { hasChannel = (await listChannels()).some((c) => c.session_id === sessionId && isChannelDeliveryReady(c)); } catch { /* treat as unreachable */ }
      const isIdle = !isPi && !!target && target.alive && target.status === 'idle' && hasChannel;
      if (!isIdle) {
        const envelope = tracker.createDispatchEnvelope(id, { session_id: sessionId, actor: senderId || 'human', sender_id: senderId });
        const briefString = buildDispatchBrief(existing, note, workspace, envelope.id);
        tracker.setEnvelopePayload(envelope.id, { content: briefString, envelope_id: envelope.id, sender_id: envelope.sender_id, reply_to_session_id: envelope.reply_to_session_id, recipient_session_id: envelope.recipient_session_id });
        const queueRow = tracker.queueDispatch(id, { session_id: sessionId, note, workspace, payload: briefString, envelope_id: envelope.id, actor: senderId || 'human' });
        chat.record('system', 'info',
          `queued ${queueRow.id.slice(0, 8)} for ${sessionId} — will deliver when idle`);
        const ticket = tracker.getTicket(id);
        broadcastWS({ type: 'ticket-updated', ticket });
        // TKT-0286: signal every queue-aware surface (Agents page chips, the
        // session peek drawer list, offline orphans) to refetch.
        broadcastWS({ type: 'dispatch-queue-updated' });
        broadcastWS({ type: 'communication-health-updated' });
        return { ok: true, queued: true, delivered: false, queue_id: queueRow.id, envelope_id: queueRow.envelope_id, ticket };
      }
      // target idle + reachable → fall through to immediate delivery below.
    }

    // 1) Durable write — assign + record the dispatched event. Source of truth.
    const assigned = tracker.setDispatched(id, { session_id: sessionId, actor: senderId || 'human' });
    if (assigned.revoked_session_id) await pushDispatchRevoked(assigned, assigned.revoked_session_id, 'redispatched');

    // 2) Build a clear, self-contained brief so the receiving session knows
    //    exactly what it's been handed and how to pick it up. The tracker MCP
    //    tools (ticket_get, etc.) land in WS3 — naming them now is intentional.
    //    (TKT-0245: extracted to buildDispatchBrief so the drainer produces
    //    byte-identical briefs.)
    const envelope = tracker.createDispatchEnvelope(id, { session_id: sessionId, actor: senderId || 'human', sender_id: senderId });
    const baseBriefString = buildDispatchBrief(existing, note, workspace, envelope.id);
    const passive = appendPassiveDelta(tracker, sessionId, baseBriefString);
    const briefString = passive.brief;
    tracker.setEnvelopePayload(envelope.id, { content: briefString, envelope_id: envelope.id, sender_id: envelope.sender_id, reply_to_session_id: envelope.reply_to_session_id, recipient_session_id: envelope.recipient_session_id });

    // 3) Best-effort channel push — never fail the request on a push miss.
    let channelResult = null;
    let passiveCommitted = false;
    try {
      try {
        channelResult = await pushBrief(briefString, sessionId, { envelope_id: envelope.id, sender_session_id: envelope.sender_session_id, target_session_id: sessionId });
      } catch (err) {
        channelResult = { ok: false, error: String(err?.message ?? err) };
      }
      // The push is the delivery opportunity. Set this before chat or tracker
      // writes so their failures cannot release delivered passive context.
      passiveCommitted = !!channelResult?.ok;
      if (channelResult && channelResult.ok) {
        chat.record('user', 'brief', briefString, { session_id: sessionId, delivery: channelResult.queued ? 'next_turn' : 'push' });
      } else {
        const detail = channelResult?.error || `status ${channelResult?.status ?? '?'}`;
        chat.record('system', 'error', `dispatch of ${existing.display_id || id} to ${sessionId} — channel ${detail} (ticket assigned; session will pick it up on resume)`);
      }
      tracker.markDispatchDeliveryAttempted(id, {
        session_id: sessionId,
        actor: 'human',
        error: channelResult && channelResult.ok ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`),
        envelope_id: envelope.id,
      });
      tracker.markEnvelopeDelivery(envelope.id, {
        error: channelResult && channelResult.ok ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`),
      });
    } finally {
      settlePassiveDelta(tracker, sessionId, passive.claim, passiveCommitted);
    }
    if (channelResult && channelResult.ok) {
      tracker.markCommentDispatchesDeliveredForTicket(id, sessionId);
    }

    const ticket = tracker.getTicket(id);
    broadcastWS({ type: 'ticket-updated', ticket });
    broadcastWS({ type: 'communication-health-updated' });
    // Bare 'now' POSTs (the default) keep the exact original response shape so
    // existing callers (MCP ticket_dispatch, older UI) are untouched. The
    // when_idle path that fell through (target was already idle) adds the
    // queued:false / delivered:true hints the plan specifies.
    const delivered = !!channelResult?.ok && !channelResult?.queued;
    const queued = !!channelResult?.queued;
    return { ok: delivered || queued, assignment: { ok: true, ticket }, queued, delivered, envelope_id: envelope.id, ticket,
      delivery: { ok: delivered || queued, queued, mode: queued ? 'next_turn' : 'push', status: channelResult?.status ?? 0, error: delivered || queued ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`) }, channel: channelResult };
  });

  // GOL-421: channel acknowledgements/replies are correlated to an envelope and
  // only the stored dispatch target may advance its lifecycle.
  fastify.post('/api/message-envelopes/:id/ack', async (req, reply) => {
    try {
      const trustedCaller = typeof req.headers['x-golem-caller-session'] === 'string' ? req.headers['x-golem-caller-session'] : '';
      const envelope = tracker.acknowledgeEnvelope(req.params.id, { ...(req.body ?? {}), target_session_id: trustedCaller });
      const ticket = envelope?.ticket_id ? tracker.getTicket(envelope.ticket_id) : null;
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'communication-health-updated' });
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return { ok: true, envelope };
    } catch (err) {
      const msg = String(err?.message ?? err);
      return reply.code(/not found/.test(msg) ? 404 : 403).send({ error: msg });
    }
  });
  fastify.post('/api/message-envelopes/:id/reply', async (req, reply) => {
    try {
      const trustedCaller = typeof req.headers['x-golem-caller-session'] === 'string' ? req.headers['x-golem-caller-session'] : '';
      const result = tracker.replyEnvelope(req.params.id, { ...(req.body ?? {}), target_session_id: trustedCaller });
      const envelope = result.envelope;
      // Route to the durable sender identity, never to an ambient/requesting
      // session. Human-originated dispatches deliberately have no channel route.
      let sender_delivery = null;
      if (result.reply.recipient_session_id) {
        const baseBrief = `Reply for dispatch ${envelope.ticket_id}: ${String(req.body?.text || '')}`;
        const passive = appendPassiveDelta(tracker, result.reply.recipient_session_id, baseBrief);
        let passiveCommitted = false;
        try {
          sender_delivery = await pushBrief(
            passive.brief,
            result.reply.recipient_session_id,
            { envelope_id: result.reply.id, sender_session_id: trustedCaller || null, target_session_id: result.reply.recipient_session_id },
          );
          passiveCommitted = !!sender_delivery?.ok;
          tracker.markEnvelopeDelivery(result.reply.id, { error: sender_delivery.ok ? null : (sender_delivery.error || `status ${sender_delivery.status}`) });
        } finally {
          settlePassiveDelta(tracker, result.reply.recipient_session_id, passive.claim, passiveCommitted);
        }
      }
      const ticket = envelope?.ticket_id ? tracker.getTicket(envelope.ticket_id) : null;
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'communication-health-updated' });
      return { ok: true, envelope, reply: result.reply, sender_delivery };
    } catch (err) {
      const msg = String(err?.message ?? err);
      return reply.code(/not found/.test(msg) ? 404 : 403).send({ error: msg });
    }
  });

  // TKT-0245: GET /api/dispatch-queue — list pending queued dispatches,
  // optionally filtered by ?session_id=. Used by the UI (and the smoke) to
  // discover + cancel pending rows for a session.
  // TKT-0286: queue-wide view. Optional session / project / status filters
  // (default status=pending; status=all → every status for history). Accepts
  // `session` (new) AND `session_id` (0245 backcompat). Rows are enriched with
  // ticket_title + session_label by listDispatchQueue.
  fastify.get('/api/dispatch-queue', async (req) => {
    const q = req.query ?? {};
    const sessionId = q.session || q.session_id || null;
    const projectId = q.project != null ? resolveProjectId(q.project) : null;
    let status = q.status || 'pending';
    if (status === 'all') status = null;
    return tracker.listDispatchQueue({ session_id: sessionId, project_id: projectId, status });
  });

  // TKT-0245: DELETE /api/dispatch-queue/:qid — cancel a pending queued
  // dispatch. Broadcasts a ticket-updated for the affected ticket so the drawer
  // re-renders back to the dispatch row. 404 if no such pending row.
  fastify.delete('/api/dispatch-queue/:qid', async (req, reply) => {
    const qid = req.params.qid;
    try {
      const row = tracker.cancelQueuedDispatch(qid, { actor: 'human' });
      const ticket = tracker.getTicket(row.ticket_id);
      await pushDispatchRevoked(ticket, row.session_id, 'queued dispatch cancelled');
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      // TKT-0286: signal queue-aware surfaces to refetch (the row is gone).
      broadcastWS({ type: 'dispatch-queue-updated' });
      broadcastWS({ type: 'communication-health-updated' });
      return { ok: true };
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/not found|not pending/i.test(msg)) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  // GOL-423: local Claude Code hooks and actionable envelope paths share this
  // lease protocol. A busy lease deliberately returns 409 rather than creating
  // a second batch; callers fail open and retry on their next real turn.
  fastify.post('/api/passive-deltas/:sessionId/claim', async (req, reply) => {
    const sessionId = String(req.params.sessionId || '').trim();
    if (!requirePassiveCaller(req, reply, sessionId)) return;
    try {
      const result = tracker.claimPassiveDelta(sessionId);
      if (result.busy) return reply.code(409).send({ ok: false, error: 'passive delta is already claimed', retry_at: result.retry_at });
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/passive-deltas/:sessionId/commit', async (req, reply) => {
    const sessionId = String(req.params.sessionId || '').trim();
    if (!requirePassiveCaller(req, reply, sessionId)) return;
    try {
      return { ok: true, ...tracker.commitPassiveDelta(sessionId, req.body?.lease_id) };
    } catch (err) {
      return reply.code(/lease/.test(String(err?.message ?? err)) ? 409 : 400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/passive-deltas/:sessionId/release', async (req, reply) => {
    const sessionId = String(req.params.sessionId || '').trim();
    if (!requirePassiveCaller(req, reply, sessionId)) return;
    try {
      return { ok: true, ...tracker.releasePassiveDelta(sessionId, req.body?.lease_id) };
    } catch (err) {
      return reply.code(/lease/.test(String(err?.message ?? err)) ? 409 : 400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/bus/subscribe', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const sub = tracker.subscribe({
        session_id: b.session_id,
        topic: b.topic,
        classes: b.classes,
        cursor_seq: b.cursor_seq,
        expires_at: b.expires_at,
        reason: b.reason || 'manual',
      });
      broadcastWS({ type: 'bus-subscriptions-updated' });
      return reply.code(201).send(sub);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/bus/unsubscribe', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const result = tracker.unsubscribe({ session_id: b.session_id, topic: b.topic, reason: b.reason || 'manual' });
      broadcastWS({ type: 'bus-subscriptions-updated' });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/bus/subscriptions', async (req) => {
    const sessionId = typeof req.query?.session_id === 'string' ? req.query.session_id : null;
    return tracker.listSubscriptions({ session_id: sessionId });
  });

  fastify.get('/api/bus/stats', async () => tracker.busStats());

  fastify.post('/api/bus/ingest', async (req, reply) => {
    try {
      const result = tracker.ingestBusEvents(req.body ?? {});
      const session_status = updateSessionMaterializedStatusFromIngest(result);
      if (session_status.updated && typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
      broadcastWS({ type: 'bus-ingested', result: { ...result, events: undefined }, session_status });
      if (session_status.updated) {
        broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      }
      return reply.code(202).send({ ...result, session_status });
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/bus/prune', async (req, reply) => {
    try {
      const result = tracker.pruneBus(req.body ?? {});
      broadcastWS({ type: 'bus-pruned', result });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/streams — streams for one project, or all if `project` omitted.
  fastify.get('/api/streams', async (req) => {
    const project = req.query?.project;
    if (project != null) return tracker.listStreams(resolveProjectId(project));
    return listAllStreams();
  });

  // POST /api/streams — create a stream. 400 on validation error.
  fastify.post('/api/streams', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const stream = tracker.createStream({
        project_id: b.project_id,
        name: b.name,
        mode: b.mode,
        description: b.description,
      });
      broadcastWS({ type: 'stream-updated', stream });
      return reply.code(201).send(stream);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // PATCH /api/streams/:id — update a stream. 404 if missing, 400 on invalid.
  fastify.patch('/api/streams/:id', async (req, reply) => {
    try {
      const stream = tracker.updateStream(req.params.id, req.body ?? {});
      broadcastWS({ type: 'stream-updated', stream });
      return stream;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // GET /api/sessions/dispatchable — live native sessions in a project (alive,
  // matching the requested contract project_id). Channel presence is an
  // ANNOTATION, not a filter (TKT-0369): an alive legacy session whose channel
  // MCP died stays listed with reachable:false so the UI can offer durable
  // when-idle queueing (delivered when the channel re-registers). Fact-backed
  // rows still require an authenticated healthy endpoint, but not immediate
  // delivery readiness: healthy busy/waiting targets are queueable. `project`
  // omitted → all dispatchable sessions (each annotated with its project_id).
  fastify.get('/api/sessions/dispatchable', async (req) => {
    const wanted = req.query?.project != null ? resolveProjectId(req.query.project) : null;
    let channels = [];
    try {
      channels = await readChannels();
    } catch (err) {
      // Don't let a registration/channel read failure go silently latent —
      // the previous bare catch hid a missing-import ReferenceError for ~1 day
      // and presented as a permanently-disabled dispatch field.
      console.error('[dispatchable] readChannels failed:', err);
      channels = [];
    }
    const channelBySession = new Map();
    for (const c of channels) if (c.session_id) channelBySession.set(c.session_id, c);
    const teamBySession = new Map(buildTeamRows(wanted, { channels, aliveOnly: true }).map((row) => [row.session_id, row]));

    const out = [];
    for (const s of enrichSessionRows(state.nativeSessions(), channels)) {
      if (!s.alive) continue;
      if (wanted != null && s.project_id !== wanted) continue;
      const ch = channelBySession.get(s.session_id);
      // Once a harness has adopted canonical facts, an authenticated healthy
      // endpoint lease is part of dispatchability. Legacy rows retain the
      // queue-while-unreachable compatibility behavior during migration.
      if (s.fact_observed_at && !hasAuthenticatedHealthyChannel(s)) continue;
      const team = teamBySession.get(s.session_id);
      // TKT-0369: an alive session whose channel MCP died must NOT silently
      // vanish from the picker — it stays listed with reachable:false so the UI
      // can offer durable when-idle queueing (delivered when the channel
      // re-registers, e.g. after /reload-plugins). Channel presence is now an
      // annotation, not a filter.
      out.push({
        ...s,
        session_id: s.session_id,
        name: s.name ?? null,
        label: s.name || `session ${String(s.session_id ?? '').slice(0, 8)}`,
        status: s.status ?? null,
        role: s.role ?? null,
        role_mission: s.role ? roleMission(s.role) : null,
        harness: s.harness ?? 'claudecode',
        project_id: s.project_id ?? null,
        current_in_progress_ticket: tracker.currentInProgressTicketForSession(s.session_id),
        channel_url: ch ? (ch.url ?? (ch.host && ch.port ? `http://${ch.host}:${ch.port}` : null)) : null,
        started_at: s.started_at ?? null,
        updated_at: s.updated_at ?? null,
        // TKT-0245: count of pending queued dispatches for this session, so the
        // picker can show "working · 1 queued".
        pending_count: s.pending_count ?? 0,
        role_meta: team?.role_meta ?? null,
        in_progress_tickets: team?.in_progress_tickets ?? [],
        workload: team?.workload ?? {
          in_progress_tickets: [],
          pending_count: s.pending_count ?? 0,
          last_active: s.updated_at ?? s.started_at ?? null,
        },
      });
    }
    const assists = teamAssists(out);
    return out.map((row) => ({ ...row, suggested: row.session_id === assists.suggested_manager?.session_id ? 'manager' : null }));
  });

  fastify.get('/api/projects/:id/team', async (req, reply) => {
    try {
      const projectId = resolveProjectId(req.params.id);
      const rows = buildTeamRows(projectId);
      return { project_id: projectId, team: rows, assists: teamAssists(rows) };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/roles', async () => listRoleCards());

  async function pushRoleToLive(name) {
    if (typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
    const targets = state.nativeSessions().filter((s) => s.alive && s.role === name);
    const results = [];
    for (const session of targets) {
      const brief = roleChangeBrief(name, session);
      let result = { ok: false, error: 'no role assign payload' };
      if (brief) {
        try {
          const activated = await deliverControlEnvelope(tracker, {
            project_id: session.project_id ?? null,
            sender_id: 'human:dashboard',
            recipient_session_id: session.session_id,
            kind: 'role_assign',
            content: brief,
            legacy: { path: '/role', body: brief },
          });
          result = { ...activated.delivery, envelope_id: activated.envelope.id };
        } catch (error) {
          result = { ok: false, status: 0, error: String(error?.message ?? error) };
        }
      }
      results.push({
        session_id: session.session_id,
        name: session.name ?? null,
        ok: !!result.ok,
        status: result.status ?? null,
        error: result.error ?? null,
        target: result.target ?? null,
      });
      chat.record(result.ok ? 'system' : 'error', 'session_role_push', `role ${name} push ${result.ok ? 'delivered' : 'failed'} for ${session.name || session.session_id}`, { session_id: session.session_id });
    }
    return { role: name, count: results.length, results };
  }

  fastify.post('/api/roles', async (req, reply) => {
    try {
      const role = createRole(req.body ?? {});
      broadcastWS({ type: 'roles-updated', roles: listRoleCards(), meta: roleMetaMap() });
      return reply.code(201).send(role);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /already exists/i.test(msg) ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  fastify.put('/api/roles/:name', async (req, reply) => {
    const name = req.params.name;
    const existing = getRole(name);
    if (!existing) return reply.code(404).send({ error: 'role_not_found' });
    try {
      const hasBody = typeof req.body?.body === 'string';
      updateRoleMeta(name, req.body ?? {});
      const role = hasBody ? writeRoleCard(existing.name, req.body.body) : listRoleCards().find((r) => r.name === existing.name);
      broadcastWS({ type: 'roles-updated', roles: listRoleCards(), meta: roleMetaMap() });
      return role;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.delete('/api/roles/:name', async (req, reply) => {
    try {
      const result = deleteRole(req.params.name, { force: req.query?.force === 'true' || req.query?.force === '1' });
      broadcastWS({ type: 'roles-updated', roles: listRoleCards(), meta: roleMetaMap() });
      if (typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return result;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : /assigned|builtin/i.test(msg) ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  fastify.post('/api/roles/:name/push', async (req, reply) => {
    const name = req.params.name;
    if (!getRole(name)) return reply.code(404).send({ error: 'role_not_found' });
    const push = await pushRoleToLive(name);
    broadcastWS({ type: 'roles-updated', roles: listRoleCards(), meta: roleMetaMap(), push });
    return push;
  });

  fastify.post('/api/sessions/:id/role', async (req, reply) => {
    const id = req.params.id;
    const body = req.body ?? {};
    const role = body.role === 'clear' ? null : (body.role ?? null);
    if (role != null && !getRole(role)) {
      return reply.code(400).send({ error: `invalid role: ${role}` });
    }
    try {
      const row = setSessionRole(id, role, { by: 'human:dashboard' });
      const text = `session role ${role ?? 'cleared'} for ${row.name || row.session_id || id}`;
      chat.record('system', 'session_role', text, { session_id: row.session_id || id });
      let activation = { ok: true, skipped: true, reason: 'role cleared; no role card activation required' };
      const brief = roleChangeBrief(role, row);
      if (brief) {
        try {
          const activated = await deliverControlEnvelope(tracker, {
            project_id: row.project_id ?? null,
            sender_id: 'human:dashboard',
            recipient_session_id: row.session_id || id,
            kind: 'role_assign',
            content: brief,
            legacy: { path: '/role', body: brief },
          });
          activation = { ...activated.delivery, envelope_id: activated.envelope.id };
        } catch (error) {
          activation = { ok: false, status: 0, error: String(error?.message ?? error) };
        }
      }
      if (!activation.ok) {
        chat.record('system', 'warning', activation.error, { session_id: row.session_id || id });
      }
      if (typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return { ok: true, saved: true, session: row, activation };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // GET /api/templates — genre scaffolds (feature/bug/design-doc/prd/brainstorm/
  // decision) shipped as Markdown bodies. Reads the templates dir at
  // plugin/skills/tracker/templates/ (outside dashboard/), returns one entry per
  // .md file: { id, title, body }. id = filename stem; title = first `# ` heading
  // in the file, or the stem if none. body = the raw markdown, verbatim. Used by
  // the create-ticket composer's template picker.
  fastify.get('/api/templates', async () => {
    let files = [];
    try {
      files = fs.readdirSync(TEMPLATES_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch (err) {
      fastify.log.error({ err }, '[templates] could not read templates dir %s', TEMPLATES_DIR);
      return [];
    }
    const out = [];
    for (const file of files) {
      const id = file.slice(0, -3); // strip .md
      let body = '';
      try {
        body = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
      } catch (err) {
        fastify.log.warn({ err }, '[templates] could not read %s', file);
        continue;
      }
      // First `# ` heading wins; fall back to the id.
      let title = id;
      for (const line of body.split('\n')) {
        const m = /^#\s+(.+?)\s*$/.exec(line);
        if (m) { title = m[1]; break; }
      }
      out.push({ id, title, body });
    }
    return out;
  });

  // TKT-0206: global ideas stack. A FIFO queue of raw thoughts the user
  // drops via the bottom-left anchor in the dashboard. Each idea is a
  // .md file at ~/.golem/ideas/ with frontmatter (id, created_at,
  // status) + body. "Popping" deletes the file (the user is taking it
  // forward — likely into a tracker ticket).
  fastify.get('/api/ideas', async () => listIdeas());

  fastify.post('/api/ideas', async (req, reply) => {
    try {
      const idea = await createIdea({ body: req.body?.body || '' });
      return idea;
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  fastify.post('/api/ideas/:id/pop', async (req, reply) => {
    try {
      return await popIdea(req.params.id);
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  fastify.post('/api/ideas/:id/promote', async (req, reply) => {
    try {
      const idea = await readIdea(req.params.id);
      const b = req.body ?? {};
      const projectId = resolveProjectId(b.project_id || b.project || 'golem-1eba80');
      const title = String(b.title || idea.body.split('\n')[0] || 'Promoted idea').trim().slice(0, 120) || 'Promoted idea';
      const ticket = tracker.createTicket({
        project_id: projectId,
        kind: 'spec',
        title,
        body: ideaSpecBody(idea.body),
        state: 'todo',
        source_ref: `ideas/${idea.id}`,
        created_by: b.created_by || 'human:ideas',
      });
      await popIdea(idea.id);
      broadcastWS({ type: 'ticket-created', ticket });
      return reply.code(201).send({ idea_id: idea.id, ticket });
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // ---- WebSocket ----

  const sockets = new Set();

  fastify.register(async (fast) => {
    fast.get('/ws', { websocket: true }, (socket /*, req*/) => {
      sockets.add(socket);

      // Send full snapshot on connect.
      try {
        socket.send(
            JSON.stringify({
              type: 'snapshot',
              payload: {
                ...state.snapshot(),
                native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()),
                ...trackerSnapshot(),
                chat: chat.snapshot(),
              },
              ts: Date.now(),
            }),
        );
      } catch (err) {
        fastify.log.warn({ err }, 'ws snapshot send failed');
      }

      socket.on('message', (raw) => {
        let msg = null;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') {
          try {
            socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          } catch {
            /* ignore */
          }
          return;
        }
        // v3 subscribe-agent removed in TKT-0009.
      });

      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
  });

  function broadcastWS(payloadObj) {
    if (sockets.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify({ ...payloadObj, ts: Date.now() });
    } catch (err) {
      fastify.log.warn({ err }, 'failed to serialise ws payload');
      return;
    }
    for (const sock of sockets) {
      if (sock.readyState !== 1) continue;
      try {
        sock.send(payload);
      } catch {
        sockets.delete(sock);
      }
    }
  }

  // Chat messages → all connected sockets.
  chat.on('message', (m) => {
    broadcastWS({ type: 'chat-message', message: m });
  });

  // Forward state events → all connected sockets.
  state.on('event', (ev) => {
    if (sockets.size === 0) return;
    if (ev?.type === 'native-sessions-update') {
      ev = {
        ...ev,
        native_sessions: enrichSessionRows(ev.native_sessions || state.nativeSessions(), ev.channels || state.channels()),
      };
    }
    let payload;
    try {
      payload = JSON.stringify({ ...ev, ts: Date.now() });
    } catch (err) {
      fastify.log.warn({ err }, 'failed to serialise state event');
      return;
    }
    for (const sock of sockets) {
      if (sock.readyState !== 1) continue;
      try {
        sock.send(payload);
      } catch {
        sockets.delete(sock);
      }
    }
  });

  // TKT-0105: 14-day done → archived auto-archive sweep. Runs once on
  // startup, then every 6 hours. The endpoint POST /api/tickets/auto-archive/sweep
  // triggers the same function on demand for tests and admin overrides.
  function runAutoArchiveSweep() {
    try {
      const ids = tracker.autoArchiveDone();
      if (ids.length > 0) {
        fastify.log.info({ count: ids.length }, 'auto-archived done tickets');
        broadcastWS({ type: 'tickets-batch-archived', ids });
      }
      return ids;
    } catch (err) {
      fastify.log.warn({ err }, 'auto-archive sweep failed');
      return [];
    }
  }
  // Run once on startup so a freshly-restarted dashboard catches up.
  setImmediate(() => runAutoArchiveSweep());
  // Periodic sweep every 6 hours. Unref so it doesn't keep the event loop
  // alive on shutdown.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const sweepTimer = setInterval(runAutoArchiveSweep, SIX_HOURS_MS);
  sweepTimer.unref();

  // TKT-0245: dispatch drainer — delivers queued dispatches when their target
  // session goes idle. Own 5s tick (reads state.nativeSessions(), which state.js
  // already refreshes every 3s — no new session poll). Closed in shutdown().
  const dispatchDrainer = initDispatchDrainer({
    tracker,
    state,
    chat,
    pushBrief,
    pushControlEnvelope,
    buildDispatchBrief,
    broadcastWS,
    listChannels,
  });

  // Pin to the canonical dashboard URL http://dashboard.golem.localhost:7420.
  // If 7420 is busy, check whether the occupying process is the previous
  // dashboard recorded in ~/.golem/dashboard.json. If so, terminate it
  // gracefully and retry once. If it is any other process, refuse to kill it
  // and exit with a clear error. We never walk to higher ports.
  const tryListen = async (port) => {
    const previousPid = readPreviousDashboardPid();

    let bound = false;
    try {
      await fastify.listen({ host: CONFIG.host, port });
      bound = true;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }

    if (bound) {
      fastify.log.info(`dashboard listening on http://${CONFIG.host}:${port}`);
      return port;
    }

    const holder = findListenerPid(port);
    if (!holder.pid) {
      throw new Error(holder.error || `port ${port} is in use but no listener was found`);
    }

    const { pid } = holder;
    if (previousPid && pid === previousPid && isProcessAlive(previousPid)) {
      fastify.log.info(`replacing previous dashboard pid=${previousPid}`);
      try {
        process.kill(previousPid, 'SIGTERM');
      } catch (err) {
        fastify.log.warn({ err }, `SIGTERM to previous dashboard pid=${previousPid} failed`);
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (!isProcessAlive(previousPid)) break;
        await sleep(200);
      }
      if (isProcessAlive(previousPid)) {
        fastify.log.warn(`previous dashboard pid=${previousPid} did not exit after 3s; sending SIGKILL`);
        try {
          process.kill(previousPid, 'SIGKILL');
        } catch (err) {
          fastify.log.warn({ err }, `SIGKILL to previous dashboard pid=${previousPid} failed`);
        }
        await sleep(1000);
      }
      try {
        await fastify.listen({ host: CONFIG.host, port });
        fastify.log.info(`dashboard listening on http://${CONFIG.host}:${port}`);
        return port;
      } catch (err) {
        throw new Error(`port ${port} still in use after replacing previous dashboard: ${err.message}`);
      }
    }

    const comm = getProcessComm(pid);
    console.error(
      `port ${port} is held by pid ${pid} (${comm}) — not the previous dashboard; refusing to kill it. Stop that process and retry.`,
    );
    process.exit(1);
  };

  // Canonical URL is http://dashboard.golem.localhost:7420 (RFC 6761 *.localhost
  // resolves to 127.0.0.1 — no /etc/hosts edit needed).
  const boundPort = await tryListen(CONFIG.port);

  // WS2: self-register so WS3's MCP discovery can find the live dashboard.
  // Atomic write (tmp + rename) into ~/.golem/dashboard.json. Best-effort
  // — a write failure logs a warning and must NOT crash the server. We LEAVE the
  // file on shutdown (a stale entry is harmless: consumers health-check the URL).
  try {
    const dir = golemHome();
    fs.mkdirSync(dir, { recursive: true });
    const target = dashboardJsonPath();
    const tmp = path.join(dir, `.dashboard.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const doc = {
      url:
        CONFIG.host === '127.0.0.1' && boundPort === 7420
          ? `http://dashboard.golem.localhost:${boundPort}`
          : `http://${CONFIG.host}:${boundPort}`,
      host: CONFIG.host,
      port: boundPort,
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
    fastify.log.info(`self-registered at ${target}`);
  } catch (err) {
    fastify.log.warn({ err }, 'dashboard self-registration failed (non-fatal)');
  }

  // Clean shutdown.
  const shutdown = async () => {
    fastify.log.info('shutting down…');
    try {
      dispatchDrainer.close();
      chat.stop();
      await state.close();
      tracker.close();
      await fastify.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
