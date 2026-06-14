// Live data store. Replaces the design's static `data.js` simulation with a
// real-time store backed by REST snapshot + WS deltas.
//
// Public surface (mirrors what the JSX components expect):
//
//   window.Store = {
//     subscribe(fn) → unsubscribe                  // fires after every state change
//     getState()                                   // returns the current snapshot
//     getProject(id), getAgent(agentId),           // selectors
//     getProjectAgents(id), getProjectActiveAgents(id),
//     getActiveAgents(), getProjectTickets(id),
//     loadAgentDetail(projectId, agentId) → agent  // hits REST for full journal/hooks
//   }
//
// State shape:
//   {
//     ready: bool,                         // first snapshot received
//     connection: 'connecting'|'connected'|'disconnected',
//     projects: [ProjectSummary],
//     agentsByProject: Map<projectId, Agent[]>,
//     ticketsByProject: Map<projectId, Ticket[]>,
//     agentDetail: Map<agentId, FullAgent>,  // populated lazily on drawer open
//     roles: Map<roleKey, RoleInfo>,
//     columns: ['triage','open',...],
//   }

(function () {
  const ROLES_FALLBACK = {
    UNK: { label: 'Agent', color: '#8a909c', glyph: '··' },
  };

  const ORCH_EMPTY = {
    ceo: null,
    sessions: [],
    workspaces: [],
    headlineMemo: null,
    gates: [],
    gateCounts: { awaiting: 0, approved: 0, denied: 0, cancelled: 0, total: 0 },
  };

  const state = {
    ready: false,
    connection: 'connecting',
    projects: [],
    agentsByProject: new Map(),
    ticketsByProject: new Map(),
    agentDetail: new Map(),
    // v4 (fix round 2): per-native-session peek cache, keyed by session_id.
    // Populated lazily on drawer open, mirroring agentDetail.
    nativeSessionPeek: new Map(),
    orchestrator: ORCH_EMPTY,
    chat: [],
    chatCap: 200,
    roles: { ...ROLES_FALLBACK },
    columns: ['triage', 'open', 'in-progress', 'review', 'blocked', 'done'],
    serverTime: null,
    // v4: all native Claude Code sessions (not just substrated/golem ones).
    nativeSessions: [],
    // v4: live channel registrations keyed by CEO session_id. Lets the command
    // center decide, per native session, whether a brief can be delivered.
    channels: [],
    // v4: cross-project milestone feed (newest first), each project-chipped.
    recentMilestones: [],
  };

  const listeners = new Set();
  let notifyTimer = null;
  function notify() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const fn of [...listeners]) {
        try {
          fn(state);
        } catch (err) {
          console.error('store listener error', err);
        }
      }
    }, 0);
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.projects = Array.isArray(snap.projects) ? snap.projects : [];
    state.agentsByProject = new Map();
    state.ticketsByProject = new Map();
    if (Array.isArray(snap.agents)) {
      for (const a of snap.agents) {
        const list = state.agentsByProject.get(a.project) ?? [];
        list.push(a);
        state.agentsByProject.set(a.project, list);
      }
    }
    if (Array.isArray(snap.tickets)) {
      for (const t of snap.tickets) {
        const list = state.ticketsByProject.get(t.project) ?? [];
        list.push(t);
        state.ticketsByProject.set(t.project, list);
      }
    }
    if (snap.orchestrator) state.orchestrator = snap.orchestrator;
    if (Array.isArray(snap.chat)) state.chat = snap.chat.slice();
    if (Array.isArray(snap.native_sessions)) state.nativeSessions = snap.native_sessions.slice();
    if (Array.isArray(snap.channels)) state.channels = snap.channels.slice();
    if (Array.isArray(snap.recent_milestones)) state.recentMilestones = snap.recent_milestones.slice();
    state.ready = true;
    notify();
  }

  function applyNativeSessionsUpdate({ native_sessions, channels }) {
    if (Array.isArray(native_sessions)) state.nativeSessions = native_sessions.slice();
    if (Array.isArray(channels)) state.channels = channels.slice();
    notify();
  }

  function applyChatMessage({ message }) {
    if (!message || typeof message !== 'object') return;
    // De-dup by id if present (snapshot may include messages we already saw).
    if (message.id && state.chat.some((m) => m.id === message.id)) return;
    const next = state.chat.concat(message);
    while (next.length > state.chatCap) next.shift();
    state.chat = next;
    notify();
  }

  function applyOrchestratorUpdate({ orchestrator }) {
    if (!orchestrator) return;
    state.orchestrator = orchestrator;
    notify();
  }

  // Rebuild the cross-project milestone feed from the per-project summaries.
  // The snapshot ships a server-merged `recent_milestones`, but live WS deltas
  // (project-update / projects-list) only carry a single project's milestones —
  // so we recompute client-side from state.projects to keep the feed fresh.
  function recomputeMilestones(cap = 40) {
    const merged = [];
    for (const p of state.projects) {
      for (const m of p.milestones ?? []) {
        merged.push({
          t: m.t,
          text: m.text,
          session_id: m.session_id ?? null,
          project: p.id,
          project_name: p.name,
          project_color: p.color,
          project_glyph: p.glyph,
        });
      }
    }
    merged.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    state.recentMilestones = merged.slice(0, cap);
  }

  function applyAgentsUpdate({ projectId, agents }) {
    if (!projectId) return;
    state.agentsByProject.set(projectId, Array.isArray(agents) ? agents : []);
    notify();
  }

  function applyTicketsUpdate({ projectId, tickets }) {
    if (!projectId) return;
    state.ticketsByProject.set(projectId, Array.isArray(tickets) ? tickets : []);
    notify();
  }

  function applyProjectUpdate({ project }) {
    if (!project) return;
    const idx = state.projects.findIndex((p) => p.id === project.id);
    if (idx === -1) state.projects = [...state.projects, project];
    else {
      const next = state.projects.slice();
      next[idx] = project;
      state.projects = next;
    }
    recomputeMilestones();
    notify();
  }

  function applyProjectsList({ projects }) {
    if (!Array.isArray(projects)) return;
    state.projects = projects;
    // Drop agents/tickets for projects that no longer exist.
    const ids = new Set(projects.map((p) => p.id));
    for (const id of [...state.agentsByProject.keys()]) {
      if (!ids.has(id)) state.agentsByProject.delete(id);
    }
    for (const id of [...state.ticketsByProject.keys()]) {
      if (!ids.has(id)) state.ticketsByProject.delete(id);
    }
    recomputeMilestones();
    notify();
  }

  function applyAgentDetail({ agent }) {
    if (!agent) return;
    state.agentDetail.set(agent.id, agent);
    notify();
  }

  function isLive(a) {
    return a.status === 'active' || a.status === 'running' || a.status === 'review';
  }

  // ---- Selectors used by components ----

  function getProject(id) {
    return state.projects.find((p) => p.id === id) ?? null;
  }
  // Resolve the dashboard project record for a derived contract project_id.
  // Native sessions / gates / milestones carry the CONTRACT project_id
  // (`<slug>-<6hex>`), but a project's dashboard `id` is its registry id
  // (e.g. "trialroom-ai") which often differs from the contract id
  // ("trialroomai-74ac11"). Match on `project_id` first, then fall back to `id`
  // (covers entries discovered without a registry, where id === contract id).
  function getProjectByContractId(contractId) {
    if (!contractId) return null;
    return (
      state.projects.find((p) => p.project_id === contractId) ??
      state.projects.find((p) => p.id === contractId) ??
      null
    );
  }
  function getProjectAgents(id) {
    return state.agentsByProject.get(id) ?? [];
  }
  function getProjectActiveAgents(id) {
    return getProjectAgents(id).filter(isLive);
  }
  function getProjectTickets(id) {
    return state.ticketsByProject.get(id) ?? [];
  }
  function getActiveAgents() {
    const out = [];
    for (const list of state.agentsByProject.values()) {
      for (const a of list) if (isLive(a)) out.push(a);
    }
    return out;
  }
  function getAllAgents() {
    const out = [];
    for (const list of state.agentsByProject.values()) {
      for (const a of list) out.push(a);
    }
    return out;
  }
  function getAgent(agentId) {
    for (const list of state.agentsByProject.values()) {
      for (const a of list) if (a.id === agentId) return a;
    }
    return null;
  }
  function getRole(role) {
    if (!role) return state.roles.UNK;
    return state.roles[role] ?? state.roles.UNK;
  }

  async function loadAgentDetail(projectId, agentId) {
    try {
      const a = await window.SubstrateAPI.agentDetail(projectId, agentId);
      state.agentDetail.set(agentId, a);
      notify();
      return a;
    } catch (err) {
      console.error('loadAgentDetail failed', err);
      return null;
    }
  }

  function getAgentDetail(agentId) {
    return state.agentDetail.get(agentId) ?? null;
  }

  // v4 (fix round 2): fetch + cache a native session's peek payload (recent
  // central-journal events, milestones, transcript path). Mirrors
  // loadAgentDetail — fetches over REST, caches by session_id, notifies.
  async function loadNativeSessionPeek(sessionId) {
    if (!sessionId) return null;
    try {
      const peek = await window.SubstrateAPI.nativeSessionPeek(sessionId);
      state.nativeSessionPeek.set(sessionId, peek);
      notify();
      return peek;
    } catch (err) {
      console.error('loadNativeSessionPeek failed', err);
      return null;
    }
  }

  function getNativeSessionPeek(sessionId) {
    return sessionId ? (state.nativeSessionPeek.get(sessionId) ?? null) : null;
  }

  // ---- Boot ----

  async function bootstrap() {
    try {
      const meta = await window.SubstrateAPI.meta();
      if (meta && meta.roles) state.roles = { ...ROLES_FALLBACK, ...meta.roles };
      if (Array.isArray(meta?.columns)) state.columns = meta.columns;
    } catch (err) {
      console.warn('meta fetch failed', err);
    }
    try {
      const snap = await window.SubstrateAPI.snapshot();
      applySnapshot(snap);
    } catch (err) {
      console.error('snapshot fetch failed', err);
      state.ready = true; // still let UI render empty state
      notify();
    }
    // Open WS for live updates.
    window.SubstrateAPI.createWS({
      url: window.SubstrateAPI.wsUrl('/ws'),
      onStatus: (s) => {
        state.connection = s;
        notify();
      },
      onMessage: (msg) => {
        if (!msg) return;
        switch (msg.type) {
          case 'snapshot':
            applySnapshot(msg.payload);
            break;
          case 'agents-update':
            applyAgentsUpdate(msg);
            break;
          case 'tickets-update':
            applyTicketsUpdate(msg);
            break;
          case 'project-update':
            applyProjectUpdate(msg);
            break;
          case 'projects-list':
            applyProjectsList(msg);
            break;
          case 'agent-detail':
            applyAgentDetail(msg);
            break;
          case 'orchestrator-update':
            applyOrchestratorUpdate(msg);
            break;
          case 'native-sessions-update':
            applyNativeSessionsUpdate(msg);
            break;
          case 'chat-message':
            applyChatMessage(msg);
            break;
          case 'pong':
            state.serverTime = msg.ts;
            break;
          default:
            break;
        }
      },
    });
  }

  // Per-session chat filter. Messages without a session_id are surfaced in
  // every lane (system errors that pre-date routing fall into this bucket).
  function getChatForSession(sessionId) {
    if (!sessionId) return state.chat.slice();
    return state.chat.filter((m) => !m.session_id || m.session_id === sessionId);
  }

  // The CEO session list, deduped + sorted: live sessions first, claimed
  // projects before unbound. Each row carries channel_url so the UI can show a
  // "channel" badge / link.
  function getSessions() {
    const list = state.orchestrator?.sessions ?? [];
    return list.slice().sort((a, b) => {
      const aClaim = a.claimed_project ? 0 : 1;
      const bClaim = b.claimed_project ? 0 : 1;
      if (aClaim !== bClaim) return aClaim - bClaim;
      return (a.boot_time || '').localeCompare(b.boot_time || '');
    });
  }

  window.Store = {
    subscribe,
    getState: () => state,
    getProject,
    getProjectByContractId,
    getProjectAgents,
    getProjectActiveAgents,
    getProjectTickets,
    getActiveAgents,
    getAllAgents,
    getAgent,
    getRole,
    loadAgentDetail,
    getAgentDetail,
    loadNativeSessionPeek,
    getNativeSessionPeek,
    getNativeSessionById: (sessionId) =>
      sessionId ? (state.nativeSessions.find((s) => s.session_id === sessionId) ?? null) : null,
    getOrchestrator: () => state.orchestrator,
    getChat: () => state.chat,
    getChatForSession,
    getSessions,
    getNativeSessions: () => state.nativeSessions,
    getChannels: () => state.channels,
    // The live channel for a given session_id, or null. A native session has a
    // deliverable channel iff a channel-server registered under its session_id.
    getChannelForSession: (sessionId) =>
      sessionId ? (state.channels.find((c) => c.session_id === sessionId) ?? null) : null,
    getRecentMilestones: () => state.recentMilestones,
    // Every awaiting gate across all workspaces (already aggregated server-side
    // in orchestrator.gates — central + legacy both surface there).
    getPendingGates: () =>
      (state.orchestrator?.gates ?? []).filter((g) => g.status === 'awaiting'),
    // All gates (any status) for one workspace, newest first (server already
    // sorts orchestrator.gates by mtime desc). `workspace` on a gate is the
    // dashboard registry id.
    getProjectGates: (workspaceId) =>
      (state.orchestrator?.gates ?? []).filter((g) => g.workspace === workspaceId),
    // Native Claude Code sessions whose derived contract project_id maps to this
    // dashboard project (match the project's own contract project_id, falling
    // back to its registry id for registry-less discoveries).
    getProjectSessions: (project) => {
      if (!project) return [];
      const ids = new Set([project.project_id, project.id].filter(Boolean));
      return state.nativeSessions.filter((s) => s.project_id && ids.has(s.project_id));
    },
    // v4 (fix round 2, defect 3): alive native sessions belonging to a project.
    // The sidebar/per-project liveness dot keys off this instead of the stale
    // v3 journal-agent count.
    getProjectAliveSessions: (project) => {
      if (!project) return [];
      const ids = new Set([project.project_id, project.id].filter(Boolean));
      return state.nativeSessions.filter((s) => s.alive && s.project_id && ids.has(s.project_id));
    },
    // v4 (fix round 2, defect 3): count of ALL alive native Claude Code sessions
    // on the machine — the real "what is running" signal for the topbar.
    getAliveSessionCount: () => state.nativeSessions.filter((s) => s.alive).length,
  };

  // Kick off as soon as DOM is ready (script in <body>, so it already is).
  bootstrap();
})();
