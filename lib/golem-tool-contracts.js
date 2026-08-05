// Canonical, harness-neutral definitions for Golem tools. Harness adapters may
// translate `inputSchema` to their native schema representation, but must not
// copy or extend these definitions locally.

const string = (description) => description ? { type: 'string', description } : { type: 'string' };
const object = (properties, required) => ({
  type: 'object',
  properties,
  ...(required?.length ? { required } : {}),
});

const contracts = [
  {
    name: 'ack',
    description: 'Acknowledge a golem channel event. Fires immediately on receipt of every inbound event. One short sentence describing what was understood and what happens next.',
    inputSchema: object({
      kind: string('The kind of event being acknowledged (brief|role_assign|interrupt|halt|gate_approve|gate_deny|gate_cancel).'),
      gate_id: string('For gate_* kinds: the gate_id from the inbound event.'),
      envelope_id: string('Required when acknowledging a correlated ticket dispatch; copied from the channel event metadata.'),
      summary: string('One-sentence description of what the CEO did or will do next.'),
    }, ['kind', 'summary']),
  },
  {
    name: 'respond',
    description: 'Send a user-facing reply BACK over the golem channel — surfaces as a chat bubble in the dashboard. Use this for chat answers (e.g. status questions), clarifications, decision asks, or the final result of a short brief. Do NOT use it for intermediate reasoning, tool-call narration, sub-agent activity, or delegated peer returns; it is not a correlated peer-handoff reply. Delegated returns and consultation replies use session_notify.',
    inputSchema: object({
      text: string('The user-facing reply text. Keep it concise — the dashboard chat is a thin client, not a full transcript. Plain text is wrapped into paragraphs; existing HTML is rendered as-is.'),
      kind: string('Optional: the kind of inbound event this is responding to (brief|role_assign|interrupt|halt|gate_*). Defaults to "brief". Skip respond for role_assign.'),
      gate_id: string('Optional: gate_id if this response is about a specific gate.'),
    }, ['text']),
  },
  {
    name: 'ticket_list',
    description: 'Golem tracker — the cross-project source of truth for work (replaces PLAN.md). List tickets. Pass mine:true to find work assigned to YOU (this session). Defaults to your current project; pass project:"<contract-id>" for another, or all:true (or project:"*") to list across every project. Optional filters: state (todo|in_progress|blocked|review|done|archived), assignee, kind (work-item|decision|spec|question|fix).',
    inputSchema: object({
      project: string('Contract project_id `<slug>-<6hex>`. Defaults to your current project. Use "*" to list across all projects.'),
      all: { type: 'boolean', description: 'List across all projects (same as project:"*").' },
      mine: { type: 'boolean', description: 'Only tickets assigned to you (this session).' },
      state: string('todo|in_progress|blocked|review|done|archived'),
      assignee: string('session_id | "human" | null. Overridden by mine:true.'),
      kind: string('work-item|decision|spec|question|fix'),
    }),
  },
  {
    name: 'ticket_get',
    description: 'Golem tracker — fetch one ticket by id, including its Markdown body, anchored comments, links, and event history. Read this before starting work on a dispatched/assigned ticket.',
    inputSchema: object({ id: string('Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.') }, ['id']),
  },
  {
    name: 'ticket_create',
    description: 'Golem tracker — create a ticket (the unit of work; replaces a PLAN.md line item). The body is Markdown (+ fenced ```mermaid; GitHub-style > [!NOTE]/[!WARNING]/[!IMPORTANT] admonitions). Pick the genre template matching the kind — work-item→feature, fix→bug, spec→design-doc, decision→decision (prd/brainstorm selectable) — from plugin/skills/tracker/templates/ or GET /api/templates, and fill it in. Defaults to your current project and records you as created_by. Use parent_id to decompose larger work; stream_id to group. For a blocking human question, pass kind:"question" and assignee:"human", then pause.',
    inputSchema: object({
      title: string('Short imperative title.'), body: string('Full description / acceptance criteria. Markdown (+ fenced ```mermaid; GitHub-style > [!NOTE]/[!WARNING]/[!IMPORTANT] admonitions). Pick the template matching the kind: work-item→feature, fix→bug, spec→design-doc, decision→decision; prd/brainstorm selectable (plugin/skills/tracker/templates/ or GET /api/templates).'),
      kind: string('work-item|decision|spec|question|fix (default work-item).'), priority: string('Optional priority label.'), state: string('todo|in_progress|blocked|review|done (default todo).'),
      stream_id: string('Optional stream to group this ticket under.'), parent_id: string('Optional parent display ticket id (sub-ticket).'),
      wave: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Optional positive dependency wave number; null/omitted means not wave-managed.' },
      assignee: string('session_id | "human" | null. Use "human" for questions.'), source_ref: string('Optional provenance link, e.g. "github:<owner>/<repo>#<N>" for a spec ingested from a GitHub issue (see golem:tracker § GitHub Bridge).'),
      project: string('Contract project_id. Defaults to your current project.'),
    }, ['title']),
  },
  {
    name: 'ticket_update',
    description: 'Golem tracker — patch ticket metadata or use the legacy state field. Use ticket_transition for every lifecycle phase move; do not add phase here. The body field is Markdown (+ fenced ```mermaid). Records you as the actor.',
    inputSchema: object({
      id: string('Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.'), state: string('todo|in_progress|blocked|review|done|archived'), title: string(),
      body: string('Markdown body replacement (+ fenced ```mermaid; GitHub-style admonitions).'), kind: string('work-item|decision|spec|question|fix'), priority: string(),
      labels: { type: 'array', items: { type: 'string' }, description: 'Full replacement label set.' }, stream_id: string(), parent_id: string(),
      wave: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Optional positive dependency wave number; pass null to clear.' }, assignee: string('session_id | "human" | null.'),
    }, ['id']),
  },
  {
    name: 'ticket_transition',
    description: 'Golem tracker — move one ticket through its phase machine. Builders: queued → building → built. Managers: built → verifying and verified → done. Explorers: verifying → verified (PASS) or rejected (FAIL). Read golem:tracker and golem:verify-done first; required artifacts are enforced by the server and rejection text is returned verbatim.',
    inputSchema: object({ id: string('Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.'), phase: string('Target phase (kind-dependent), e.g. queued|building|blocked|built|verifying|verified|rejected|done.'), reason: string('Reason required by blocked/parked transitions.'), skip_reason: string('Explicit lifecycle skip reason; reserved for the lead-authorized escape hatch once phase enforcement lands.') }, ['id', 'phase']),
  },
  {
    name: 'ticket_comment',
    description: 'Golem tracker — append a progress comment to a ticket. Comment milestones with MECHANICAL evidence (commands you ran + their output), not claims. Records you as the author. For inline anchored comments, include quote (selected text), prefix/suffix context, section, and a tag (confirmed|partial|disputed|fix|risk|question|note).',
    inputSchema: object({
      id: string('Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.'), body: string('Markdown comment text (fenced ```mermaid ok for diagrams).'), quote: string('Optional: exact selected text being commented on.'),
      prefix: string('Optional: text immediately before quote, for anchoring.'), suffix: string('Optional: text immediately after quote, for anchoring.'), section: string('Optional: section title where quote appears.'), section_id: string('Optional: section id where quote appears.'),
      tag: string('confirmed|partial|disputed|fix|risk|question|note (default note).'), status: string('open|resolved (default open).'), parent_id: string('Optional: parent comment id for threading.'),
    }, ['id', 'body']),
  },
  {
    name: 'ticket_comment_update',
    description: 'Golem tracker — update an existing comment (change status to resolved/reopen, change tag, or edit body).',
    inputSchema: object({ id: string('Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.'), comment_id: string('Comment id to update.'), body: string('Replacement comment text.'), tag: string('confirmed|partial|disputed|fix|risk|question|note'), status: string('open|resolved') }, ['id', 'comment_id']),
  },
  {
    name: 'ticket_comment_reply',
    description: 'Golem tracker — add a reply to an existing comment.',
    inputSchema: object({ id: string('Display ticket id, e.g. GOL-244. Legacy TKT refs still resolve.'), comment_id: string('Parent comment id.'), body: string('Reply text.') }, ['id', 'comment_id', 'body']),
  },
  {
    name: 'session_role',
    description: 'Set or clear this live session role. role must be lead|builder|explorer|reviewer|standalone or null/clear. Legacy names (manager, planner, general, researcher, ui-tester) are rejected on write — existing sessions carrying them are rewritten by the registry migration, not by this tool.',
    inputSchema: object({ role: string('lead|builder|explorer|reviewer|standalone|clear') }, ['role']),
  },
  {
    name: 'ticket_dispatch',
    description: 'Golem tracker — dispatch a ticket to a live session: assigns the ticket and pushes a brief to it over the channel. Use sessions_dispatchable to find live session ids (each carries a status: idle|busy|waiting, and a pending_count of queued dispatches). The target session must be a channel consumer (golemc) to receive the push. By default the brief is pushed immediately (mode "now"); pass when_idle:true to queue it until the target is idle — use this when the session is busy/waiting so the brief is not buried mid-turn.',
    inputSchema: object({ id: string('Display ticket id to dispatch, e.g. GOL-244. Legacy TKT refs still resolve.'), session_id: string('Live session id to dispatch to (from sessions_dispatchable).'), note: string('Optional note to include with the dispatch.'), when_idle: { type: 'boolean', description: 'Queue the dispatch until the target session is idle instead of pushing immediately. Use when the target is busy/waiting so the brief is delivered when it can be acted on.' }, workspace: string("Optional workspace directive. Pass 'worktree' to instruct the builder to use a git worktree (branch + dir derived from ticket id/title). Only valid when the project has worktrees enabled.") }, ['id', 'session_id']),
  },
  {
    name: 'stream_create',
    description: 'Golem tracker — create a stream (a named group of tickets) in your current project. mode "sequential" = one in-progress at a time; "parallel" = independent sub-work. Defaults to your current project.',
    inputSchema: object({ name: string('Stream name.'), mode: string('sequential|parallel (default sequential).'), description: string('Optional description.'), project: string('Contract project_id. Defaults to your current project.') }, ['name']),
  },
  {
    name: 'stream_list',
    description: 'Golem tracker — list streams for a project (defaults to your current project; omit project / pass nothing for all-project view depends on dashboard).',
    inputSchema: object({ project: string('Contract project_id. Defaults to your current project.') }),
  },
  {
    name: 'sessions_dispatchable',
    description: 'Golem tracker — list live cross-harness sessions that are currently eligible to receive a dispatched ticket, in your current project (or pass project for another). Returns session ids + labels for use with ticket_dispatch. Each entry carries a status (idle|busy|waiting) and a pending_count of queued dispatches — pass when_idle:true on ticket_dispatch for a busy/waiting target so the brief lands when it next goes idle.',
    inputSchema: object({ project: string('Canonical project_id, registry id, or unique dashboard project name. Ambiguous human names fail explicitly. Defaults to your current project.') }),
  },
  {
    name: 'session_notify',
    description: 'Push an active notification to ANOTHER live session over the dashboard channel. Use it for delegated returns, milestones, review-ready/blocker pings, and consultations. This is not a ticket comment or assignment: keep the durable report/audit in the tracker, then notify the exact captured session_id. Never route by label/name or rediscover a return target.',
    inputSchema: object({ to: string('Target exact immutable session_id from sessions_dispatchable or the original authenticated handoff envelope. Labels/names are not accepted.'), text: string('The notification text. For large delegated reports, put the report in the tracker first and send a concise pointer plus next action.'), ticket: string('Optional ticket id (e.g. "GOL-267") prefixed to the message for context.') }, ['to', 'text']),
  },
  {
    name: 'project_context',
    description: 'Re-render this session\'s ambient project context — role card, LSP, recently closed work as id+title pointers, and the last 40 commits. Live recipients are intentionally not boot context: call sessions_dispatchable immediately before a new handoff. Returns pointers, never ticket bodies: pull those with ticket_get.',
    inputSchema: object({}),
  },
];

export const RETIRED_GOLEM_TOOL_CONTRACTS = Object.freeze({
  subscriptions: 'Retired with passive handoffs; active delivery uses exact session_notify and tracker-backed dispatch.',
  dedicated_gate_tools: 'Gate decisions arrive as correlated channel envelopes and are acknowledged through ack.',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const GOLEM_TOOL_CONTRACTS = deepFreeze(contracts);

export function registerGolemTools(registerTool, invoke, { names } = {}) {
  if (typeof registerTool !== 'function') throw new TypeError('registerGolemTools: registerTool must be a function');
  if (typeof invoke !== 'function') throw new TypeError('registerGolemTools: invoke must be a function');
  const selected = names ? new Set(names) : null;
  for (const contract of GOLEM_TOOL_CONTRACTS) {
    if (selected && !selected.has(contract.name)) continue;
    registerTool({ ...contract, execute: (args) => invoke(contract.name, args || {}) });
  }
}
