// Project view (v4) — the per-project command center.
//
// Top-to-bottom the page leads with the v4 progress objects, then demotes the
// v3 surfaces (agents grid, tracker board, hook-event stream) into collapsible
// legacy sections:
//
//   1. HERO            — name / glyph / counts.
//   2. PLAN            — live checklist from PLAN.md (N/M + bar), or one quiet
//                        line when the project has no plan.
//   3. MILESTONES      — this project's milestone timeline, newest first.
//   4. SESSIONS        — native Claude Code sessions in this project (reuses the
//                        home SessionCard, channel-gated composer and all).
//   5. GATES           — awaiting gates prominent (reuses GateRow); history
//                        collapsed.
//   6. LEGACY (v3)     — Agents timeline, Tracker kanban, hook-event stream,
//                        each collapsible. Collapsed by default when the project
//                        has plan/milestones (a real v4 project); expanded
//                        otherwise so v3-only projects still read sensibly.
//
// Component reuse is high: SessionCard / GateRow / PendingGatesPanel / EmptyCard
// come from dashboard.jsx (loaded earlier), PlanProgress from atoms.jsx.

const { useState: usePVState } = React;

function ProjectView({ projectId, tab, setRoute, openAgentId }) {
  useStore();
  const project = window.Store.getProject(projectId);
  const [drawerAgentId, setDrawerAgentId] = React.useState(openAgentId || null);
  const [drawerOpen, setDrawerOpen] = React.useState(!!openAgentId);

  React.useEffect(() => {
    if (openAgentId) {
      setDrawerAgentId(openAgentId);
      setDrawerOpen(true);
    }
  }, [openAgentId]);

  if (!project) {
    return (
      <div className="page">
        <EmptyCard label="unknown project"
          hint={<>Project <span className="mono">{projectId}</span> wasn't found under <span className="mono">GOLEM_PROJECTS_ROOT</span>.</>}
        />
      </div>
    );
  }

  const agents = window.Store.getProjectAgents(projectId);
  const tickets = window.Store.getProjectTickets(projectId);
  const liveAgents = agents.filter(a => ['active', 'running', 'review'].includes(a.status));
  const milestones = project.milestones || [];
  const sessions = window.Store.getProjectSessions(project);
  const gates = window.Store.getProjectGates(projectId);
  const awaitingGates = gates.filter((g) => g.status === 'awaiting');
  const historyGates = gates.filter((g) => g.status !== 'awaiting');
  const plan = project.plan;

  // A "real v4" project has a plan or a milestone trail. v3-only projects
  // (no plan, no milestones) keep their legacy sections open by default so they
  // still look populated.
  const isV4 = (plan && plan.total > 0) || milestones.length > 0;

  const openAgent = (id) => {
    setDrawerAgentId(id);
    setDrawerOpen(true);
    window.Store.loadAgentDetail(projectId, id);
  };
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <>
      <div className="page project-command-center">
        <div className="project-hero">
          <div
            className="project-hero-glyph"
            style={{
              background: `color-mix(in oklab, ${project.color} 18%, var(--bg-2))`,
              color: project.color,
              border: `1px solid color-mix(in oklab, ${project.color} 30%, transparent)`,
            }}
          >
            {project.glyph}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="project-hero-name">{project.name}</h1>
            <div className="project-hero-meta">
              <span className="mono">{project.project_id || project.id}</span>
              <span className="sep">·</span>
              <span>{project.total_tickets} tickets</span>
              <span className="sep">·</span>
              <span>{milestones.length} milestones</span>
              <span className="sep">·</span>
              <span style={{ color: 'var(--accent)' }}>{liveAgents.length} live agents</span>
              {awaitingGates.length > 0 && (<><span className="sep">·</span><span style={{ color: 'var(--status-review)' }}>{awaitingGates.length} gate{awaitingGates.length === 1 ? '' : 's'} awaiting</span></>)}
              {project.auto && (<><span className="sep">·</span><span className="native-session-badge">auto</span></>)}
            </div>
          </div>
        </div>

        {/* ── 1. PLAN ── */}
        <ProjectPlanSection plan={plan} color={project.color}/>

        {/* ── 1a. STREAMS — group tickets into sequential/parallel work (WS6) ── */}
        {window.StreamsPanel && <window.StreamsPanel contractId={project.project_id || project.id}/>}

        {/* ── 1b. TRACKER BOARD — per-project tracker.db tickets ── */}
        <ProjectTrackerBoard contractId={project.project_id || project.id}/>

        {/* ── 2. MILESTONE TIMELINE ── */}
        <ProjectMilestoneTimeline milestones={milestones}/>

        {/* ── 3. SESSIONS IN THIS PROJECT ── */}
        <ProjectSessions sessions={sessions} setRoute={setRoute} projectId={project.project_id || project.id}/>

        {/* ── 4. GATES ── */}
        <ProjectGates awaiting={awaitingGates} history={historyGates} setRoute={setRoute}/>

        {/* ── 5. LEGACY (v3) — collapsed by default on real v4 projects ──
            Keyed on projectId so collapse state resets when the route switches
            to a different project (else useState would carry the prior page's
            toggles across an in-SPA navigation). */}
        <div className="pv-legacy">
          <div className="pv-legacy-head">Legacy (v3)</div>

          <CollapsibleSection key={`agents-${projectId}`} title="Agents" count={agents.length} defaultOpen={!isV4}>
            <AgentsTimeline
              agents={agents}
              onOpen={openAgent}
              activeId={drawerOpen ? drawerAgentId : null}
              project={project}
            />
          </CollapsibleSection>

          <CollapsibleSection key={`legacy-tracker-${projectId}`} title="Legacy tracker (markdown)" count={tickets.length} defaultOpen={false}>
            {tickets.length === 0
              ? <EmptyCard label="no tickets" hint={<>This project's <span className="mono">tracker/</span> has no markdown tickets.</>}/>
              : <Kanban tickets={tickets} agents={agents}/>}
          </CollapsibleSection>

          <CollapsibleSection key={`hooks-${projectId}`} title="Hook-event stream" count={null} defaultOpen={false}>
            <HookEventStream agents={agents}/>
          </CollapsibleSection>
        </div>
      </div>

      <AgentDrawer
        projectId={projectId}
        agentId={drawerAgentId}
        open={drawerOpen}
        onClose={closeDrawer}
      />
    </>
  );
}

// ── Reusable collapsible section ──────────────────────────────────────────
function CollapsibleSection({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = usePVState(defaultOpen);
  return (
    <section className={`pv-collapse ${open ? 'open' : ''}`}>
      <button className="pv-collapse-head" onClick={() => setOpen((o) => !o)}>
        <span className="pv-collapse-caret">{open ? '▾' : '▸'}</span>
        <span className="pv-collapse-title">{title}</span>
        {count != null && <span className="pv-collapse-count tnum">{count}</span>}
      </button>
      {open && <div className="pv-collapse-body">{children}</div>}
    </section>
  );
}

// ── 1. PLAN — full live checklist (not the compact hero strip) ─────────────
function ProjectPlanSection({ plan, color }) {
  if (!plan || !plan.total) {
    return (
      <div className="pv-section">
        <div className="pv-section-head"><span className="pv-section-title">Plan</span></div>
        <div className="pv-quiet-line">no <span className="mono">PLAN.md</span> — add one at the project root to track progress here.</div>
      </div>
    );
  }
  const pct = Math.round((plan.done / plan.total) * 100);
  const barColor = color || 'var(--accent)';
  return (
    <div className="pv-section pv-plan">
      <div className="pv-section-head">
        <span className="pv-section-title">{plan.title || 'Plan'}</span>
        <span className="pv-plan-stat">
          <span className="tnum">{plan.done}/{plan.total}</span>
          <span className="pv-plan-pct tnum" style={{ color: barColor }}>{pct}%</span>
        </span>
      </div>
      <div className="pv-plan-bar">
        <div className="pv-plan-fill" style={{ width: `${pct}%`, background: barColor }}/>
      </div>
      <ul className="pv-plan-items">
        {plan.items.map((it, i) => (
          <li key={i} className={`pv-plan-item ${it.done ? 'done' : ''}`}>
            <span className="pv-plan-box">{it.done ? '✓' : '○'}</span>
            <span className="pv-plan-text">{it.text || <span style={{ color: 'var(--text-4)' }}>(empty)</span>}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 1b. TRACKER BOARD — per-project tracker.db tickets ─────────────────────
// Reuses the shared TicketColumns renderer (exported from tracker-board.jsx) so
// it never drifts from the consolidated board. Scoped to this project's CONTRACT
// project_id (NOT the dashboard registry id). Cards fire `open-ticket-drawer`
// identically; "+ New ticket" opens the create modal with this project
// preselected. A "Show archived" toggle appends the archived column.
function ProjectTrackerBoard({ contractId }) {
  useStore();
  const [showArchived, setShowArchived] = usePVState(false);

  // Per-project assignee label resolver, sourced from this project's
  // dispatchable sessions (session_id → friendly label where known).
  const [dispatchable, setDispatchable] = usePVState([]);
  React.useEffect(() => {
    if (!contractId) { setDispatchable([]); return; }
    let cancelled = false;
    window.SubstrateAPI.listDispatchable(contractId)
      .then((list) => { if (!cancelled) setDispatchable(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    return () => { cancelled = true; };
  }, [contractId]);

  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);
  const resolveAssignee = React.useCallback((a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  }, [labelBySession]);

  const tickets = window.Store.getTrackerTickets({ project_id: contractId, includeArchived: showArchived });
  const base = window.TRACKER_COLUMNS || [];
  const cols = showArchived && window.TRACKER_ARCHIVED_COL ? [...base, window.TRACKER_ARCHIVED_COL] : base;

  const onNew = () => {
    window.dispatchEvent(new CustomEvent('open-create-ticket', { detail: { project_id: contractId } }));
  };

  const Columns = window.TicketColumns;

  return (
    <div className="pv-section pv-tracker">
      <div className="pv-section-head">
        <span className="pv-section-title">Tickets</span>
        <span className="pv-section-count tnum">{tickets.length}</span>
        <div className="pv-tracker-tools">
          <label className="tracker-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}/>
            Show archived
          </label>
          <button className="orch-btn primary" onClick={onNew}>+ New ticket</button>
        </div>
      </div>
      {tickets.length === 0 && !showArchived ? (
        <div className="pv-quiet-line">
          no tracker tickets yet — click <span className="mono">+ New ticket</span> to create one in this project.
        </div>
      ) : Columns ? (
        <Columns
          cols={cols}
          tickets={tickets}
          projectByContract={null}
          resolveAssignee={resolveAssignee}
        />
      ) : null}
    </div>
  );
}

// ── 2. MILESTONE TIMELINE — newest first, the primary progress narrative ───
function ProjectMilestoneTimeline({ milestones }) {
  if (!milestones || milestones.length === 0) {
    return (
      <div className="pv-section">
        <div className="pv-section-head"><span className="pv-section-title">Milestones</span></div>
        <div className="pv-quiet-line">no milestones yet — sessions append them as work lands.</div>
      </div>
    );
  }
  // Newest first.
  const ordered = [...milestones].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return (
    <div className="pv-section pv-milestones">
      <div className="pv-section-head">
        <span className="pv-section-title">Milestones</span>
        <span className="pv-section-count tnum">{milestones.length}</span>
      </div>
      <ul className="pv-timeline">
        {ordered.map((m, i) => (
          <li key={`${m.t}-${i}`} className="pv-timeline-item">
            <span className="pv-timeline-rail"><span className="pv-timeline-dot"/></span>
            <div className="pv-timeline-body">
              <div className="pv-timeline-text">{m.text}</div>
              <div className="pv-timeline-ts mono" title={window.SubstrateFmt?.fmtClock?.(m.t) || ''}>
                {window.SubstrateFmt?.fmtTimeAgo?.(m.t) || ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 3. SESSIONS — native sessions in this project (reuses home SessionCard) ─
function ProjectSessions({ sessions, setRoute, projectId }) {
  return (
    <div className="pv-section">
      <div className="pv-section-head">
        <span className="pv-section-title">Sessions in this project</span>
        <span className="pv-section-count tnum">{sessions.length}</span>
      </div>
      {sessions.length === 0 ? (
        <div className="pv-quiet-line">
          no live <span className="mono">claude</span> session in this project. Run <span className="mono">cd</span> into it and start one — it appears here automatically.
        </div>
      ) : (
        <div className="cc-session-list">
          {sessions.map((s) => <SessionCard key={s.session_id || s.pid} session={s} setRoute={setRoute}/>)}
        </div>
      )}
    </div>
  );
}

// ── 4. GATES — awaiting prominent (reuses GateRow); history collapsed ──────
function ProjectGates({ awaiting, history, setRoute }) {
  return (
    <div className="pv-section">
      <div className="pv-section-head">
        <span className="pv-section-title">Gates</span>
        <span className={`pv-section-count tnum ${awaiting.length ? 'attn' : ''}`}>{awaiting.length}</span>
      </div>
      {awaiting.length === 0 ? (
        <div className="pv-quiet-line">no gates awaiting a decision.</div>
      ) : (
        <div className="cc-gate-list">
          {awaiting.map((g) => <GateRow key={g.gate_id} gate={g} setRoute={setRoute}/>)}
        </div>
      )}
      {history.length > 0 && (
        <CollapsibleSection title="Gate history" count={history.length} defaultOpen={false}>
          <ul className="pv-gate-history">
            {history.map((g) => (
              <li key={g.gate_id} className="pv-gate-history-row">
                <span className={`pv-gate-status status-${g.status}`}>{g.status}</span>
                <span className="pv-gate-history-flow">{g.phase_just_completed || '?'} → {g.next_phase || '?'}</span>
                <span className="pv-gate-history-id mono" title={g.gate_id}>{g.gate_id}</span>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ── Legacy: hook-event activity stream across the project's agents ─────────
// The project summary carries per-agent rollups (tool count, last action,
// last_seen) but NOT the full hook timeline — that only lands in the per-agent
// detail fetched on drawer open. So this legacy panel renders the activity
// rollup newest-first; click any agent above to open its full hook timeline.
function HookEventStream({ agents }) {
  const rows = [...agents]
    .filter((a) => (a.tools || 0) > 0 || a.action)
    .sort((x, y) => (y.last_seen ?? 0) - (x.last_seen ?? 0));
  if (rows.length === 0) {
    return <EmptyCard label="no hook activity" hint={<>Tool calls roll up here once agents fire hooks in this project. Open an agent for its full hook timeline.</>}/>;
  }
  return (
    <div className="pv-hook-stream">
      {rows.map((a, i) => (
        <div key={a.id || i} className="pv-hook-row">
          <span className="pv-hook-ts mono">{window.SubstrateFmt?.fmtClock?.(a.last_seen) || ''}</span>
          <span className="pv-hook-agent">{a.name}</span>
          <span className="pv-hook-kind mono">{a.tools || 0} hooks</span>
          <span className="pv-hook-detail mono" title={a.action || ''}>{a.action || '—'}</span>
        </div>
      ))}
    </div>
  );
}

// v4: milestones are the primary progress signal — kept exported for any
// callers that still reference the strip (home WorkCard renders its own).
function MilestoneStrip({ milestones }) {
  if (!milestones || milestones.length === 0) return null;
  const recent = milestones.slice(-8);
  return (
    <div className="milestone-strip">
      <div className="milestone-strip-head">
        <Icon.Activity size={13}/>
        <span>Milestones</span>
        <span className="milestone-strip-count">{milestones.length}</span>
      </div>
      <ul className="milestone-list">
        {recent.map((m, i) => (
          <li key={`${m.t}-${i}`} className="milestone-item">
            <span className="milestone-dot"/>
            <span className="milestone-text">{m.text}</span>
            <span className="milestone-ts mono">{window.SubstrateFmt?.fmtClock?.(m.t) || ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentsTimeline({ agents, onOpen, activeId, project }) {
  const order = { active: 0, running: 1, review: 2, blocked: 3, done: 4 };
  const sorted = [...agents].sort((a, b) => {
    const oa = order[a.status] ?? 9;
    const ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    if (a.last_seen && b.last_seen) return b.last_seen - a.last_seen;
    if (a.started && b.started) return b.started - a.started;
    return 0;
  });

  if (sorted.length === 0) {
    return (
      <EmptyCard
        label="no agent activity yet"
        hint={
          <>
            Run <span className="mono">/golem</span> in <span className="mono">{project.id}</span> to bring agents online.
            Hooks fire as soon as a session opens — agents will stream in here.
          </>
        }
      />
    );
  }

  return (
    <div className="timeline-wrap">
      <div className="timeline-header">
        <span></span>
        <span>Agent</span>
        <span>Current Action</span>
        <span>Status</span>
        <span>Runtime</span>
        <span style={{ textAlign: 'right' }}>Hooks</span>
      </div>
      <div className="timeline">
        {sorted.map(a => {
          const role = window.Store.getRole(a.role);
          const isLive = ['active', 'running', 'review'].includes(a.status);
          const runtime = a.started && isLive
            ? (Date.now() - a.started) / 1000
            : a.runtime;
          return (
            <div
              key={a.id}
              className={`timeline-row ${isLive ? 'active' : ''}`}
              onClick={() => onOpen(a.id)}
              style={activeId === a.id ? { background: 'var(--bg-3)' } : {}}
            >
              <Avatar role={a.role} size={28} pulse={a.status === 'running'}/>
              <div className="timeline-name">
                <span className="timeline-name-text">{a.name}</span>
                <span className="timeline-role">
                  {role.label}{a.team_name ? ` · ${a.team_name}` : ''}
                </span>
              </div>
              <div className={`timeline-action ${!isLive ? 'muted' : ''}`} title={a.action || ''}>
                {a.action || <span style={{ color: 'var(--text-4)' }}>—</span>}
              </div>
              <div><StatusPill status={a.status}/></div>
              <div className="timeline-runtime">{window.SubstrateFmt.fmtRuntime(runtime)}</div>
              <div className="timeline-tools">{a.tools}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Kanban({ tickets, agents }) {
  const cols = [
    { id: 'triage', label: 'Triage', color: 'var(--status-triage)' },
    { id: 'open', label: 'Open', color: 'var(--status-open)' },
    { id: 'in-progress', label: 'In Progress', color: 'var(--status-running)' },
    { id: 'review', label: 'Review', color: 'var(--status-review)' },
    { id: 'blocked', label: 'Blocked', color: 'var(--status-blocked)' },
    { id: 'done', label: 'Done', color: 'var(--status-done)' },
  ];

  const agentById = new Map(agents.map((a) => [a.id, a]));

  const prevPosRef = React.useRef(new Map());
  const [enteringIds, setEnteringIds] = React.useState(() => new Set());
  React.useEffect(() => {
    const prev = prevPosRef.current;
    const fresh = new Set();
    const next = new Map();
    for (const t of tickets) {
      next.set(t.id, t.column);
      const wasIn = prev.get(t.id);
      if (wasIn === undefined || wasIn !== t.column) fresh.add(t.id);
    }
    prevPosRef.current = next;
    if (fresh.size === 0) return;
    if (prev.size === 0) return;
    setEnteringIds((cur) => new Set([...cur, ...fresh]));
    const handle = setTimeout(() => {
      setEnteringIds((cur) => {
        const out = new Set(cur);
        for (const id of fresh) out.delete(id);
        return out;
      });
    }, 600);
    return () => clearTimeout(handle);
  }, [tickets]);

  return (
    <div className="kanban">
      {cols.map(c => {
        const colTickets = tickets.filter(t => t.column === c.id);
        return (
          <div key={c.id} className="kanban-col">
            <div className="kanban-col-header">
              <div className="kanban-col-title">
                <span className="dot" style={{ background: c.color }}/>
                {c.label}
              </div>
              <div className="kanban-col-count tnum">{colTickets.length}</div>
            </div>
            <div className="kanban-list">
              {colTickets.length === 0 && <div className="empty">empty</div>}
              {colTickets.map(t => {
                const assignee = t.assignee ? agentById.get(t.assignee) : null;
                const role = assignee ? window.Store.getRole(assignee.role) : null;
                return (
                  <div
                    key={t.id}
                    className={`ticket ${enteringIds.has(t.id) ? 'entering' : ''}`}
                    data-ticket-id={t.id}
                  >
                    <div className="ticket-id">{t.id}</div>
                    <div className="ticket-title">{t.title}</div>
                    <div className="ticket-footer">
                      {assignee ? (
                        <div className="ticket-assignee">
                          <div
                            className="ticket-assignee-avatar"
                            style={{
                              background: `color-mix(in oklab, ${role.color} 18%, var(--bg-2))`,
                              color: role.color,
                              border: `1px solid color-mix(in oklab, ${role.color} 35%, transparent)`,
                            }}
                          >
                            {role.glyph}
                          </div>
                          <span>{assignee.name}</span>
                        </div>
                      ) : (
                        <div className="ticket-assignee" style={{ color: 'var(--text-4)' }}>
                          <div className="ticket-assignee-avatar" style={{ background: 'var(--bg-3)', color: 'var(--text-4)', border: '1px dashed var(--border-2)' }}>?</div>
                          <span>Unassigned</span>
                        </div>
                      )}
                      {t.priority && (
                        <span className={`ticket-priority ${t.priority?.toLowerCase()}`}>{t.priority}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

window.ProjectView = ProjectView;
window.CollapsibleSection = CollapsibleSection;
window.MilestoneStrip = MilestoneStrip;
window.AgentsTimeline = AgentsTimeline;
window.Kanban = Kanban;
