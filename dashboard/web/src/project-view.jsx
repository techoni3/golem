// Project view (v4) — the per-project command center.
//
// The hero leads, then project-scoped sections (Plan, Tickets, Specs,
// Milestones, Sessions) — each a collapsible, re-orderable PVSection
// (TKT-0518).
// Layout (order + collapsed) is PAGE-scoped (one layout for every project's
// detail page), persisted to localStorage. The v3 journal-synthesized agents
// panel, markdown tracker kanban, hook-event stream, and gate panels were
// removed in TKT-0009.

const { useState: usePVState } = React;

// ── TKT-0518: page-layout persistence ───────────────────────────────────────
// PAGE-scoped, not project-scoped: one layout for the project-detail page no
// matter which project is open (explicit product decision on the ticket).
const PV_LAYOUT_KEY = 'golem.pv.layout.v1';
const PV_SECTION_IDS = ['plan', 'tickets', 'specs', 'milestones', 'sessions', 'streams'];
const PV_DEFAULT_COLLAPSED = { specs: true }; // today's defaults: specs closed, rest open

function pvLoadLayout() {
  try {
    const j = JSON.parse(localStorage.getItem(PV_LAYOUT_KEY) || '{}');
    return {
      order: Array.isArray(j.order) ? j.order : [],
      collapsed: (j.collapsed && typeof j.collapsed === 'object') ? j.collapsed : {},
    };
  } catch { return { order: [], collapsed: {} }; }
}

function usePvLayout() {
  const [layout, setLayout] = usePVState(pvLoadLayout);
  // Forward-compat merge: stored order first (unknown ids dropped), then any
  // known-but-unstored ids appended — a section shipped after the user saved
  // a layout still appears instead of silently vanishing.
  const order = React.useMemo(() => {
    const stored = layout.order.filter((id) => PV_SECTION_IDS.includes(id));
    return [...stored, ...PV_SECTION_IDS.filter((id) => !stored.includes(id))];
  }, [layout.order]);
  const persist = (next) => {
    setLayout(next);
    try { localStorage.setItem(PV_LAYOUT_KEY, JSON.stringify(next)); } catch { /* storage full/blocked — layout stays for this session */ }
  };
  const isOpen = (id) => !(id in layout.collapsed ? layout.collapsed[id] : PV_DEFAULT_COLLAPSED[id]);
  const toggle = (id) => persist({ ...layout, collapsed: { ...layout.collapsed, [id]: isOpen(id) } });
  const move = (id, dir) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    persist({ ...layout, order: next });
  };
  return { order, isOpen, toggle, move };
}

// ── TKT-0518: shared section shell — collapse + reorder controls ────────────
// The toggle <button> spans the whole left/middle of the head (flex:1) so the
// row is an easy click target; tools and move buttons are SIBLINGS of it, not
// children — nested interactive elements inside a <button> are invalid HTML
// and would break click handling. counts/badges stay in the head (visible when
// collapsed) so important section status remains visible.
function PVSection({ title, count, badge, extra, tools, open, onToggle, onMoveUp, onMoveDown, canUp, canDown, className, children }) {
  return (
    <section className={`pv-section pv-sec ${open ? 'open' : 'closed'}${className ? ' ' + className : ''}`}>
      <div className="pv-section-head pv-sec-head">
        <button className="pv-sec-toggle" onClick={onToggle} aria-expanded={open} title={open ? 'Collapse section' : 'Expand section'}>
          <span className="pv-sec-caret">{open ? '▾' : '▸'}</span>
          <span className="pv-section-title">{title}</span>
          {badge}
          {count != null && <span className="pv-section-count tnum">{count}</span>}
          {extra}
        </button>
        <div className="pv-sec-tools">
          {tools}
          <span className="pv-sec-move">
            <button className="pv-sec-move-btn" disabled={!canUp} onClick={onMoveUp} aria-label={`Move ${title} up`} title="Move section up">↑</button>
            <button className="pv-sec-move-btn" disabled={!canDown} onClick={onMoveDown} aria-label={`Move ${title} down`} title="Move section down">↓</button>
          </span>
        </div>
      </div>
      {open && <div className="pv-sec-body">{children}</div>}
    </section>
  );
}

function ProjectView({ projectId, tab, setRoute }) {
  useStore();
  const project = window.Store.getProject(projectId);
  // Hooks rule: usePvLayout calls useState/useMemo, so it MUST run before the
  // early return for an unknown project (hooks can't be conditional).
  const { order, isOpen, toggle, move } = usePvLayout();

  if (!project) {
    return (
      <div className="page">
        <EmptyCard label="unknown project"
          hint={<>Project <span className="mono">{projectId}</span> wasn't found under <span className="mono">GOLEM_PROJECTS_ROOT</span>.</>}
        />
      </div>
    );
  }

  const milestones = project.milestones || [];
  const sessions = window.Store.getProjectSessions(project);
  const aliveSessions = window.Store.getProjectAliveSessions(project);
  const plan = project.plan;
  const cid = project.project_id || project.id;

  // TKT-0518: render sections from the persisted layout. key={id} is
  // load-bearing — React reconciles by key, so a reorder preserves each
  // section's internal state (e.g. Tickets' showArchived + fetched dispatchable)
  // instead of remounting it.
  const renderSection = (id, shell) => {
    switch (id) {
      case 'plan':       return <ProjectPlanSection key={id} plan={plan} color={project.color} {...shell}/>;
      case 'tickets':    return <ProjectTrackerBoard key={id} contractId={cid} {...shell}/>;
      // TKT-0339: spec-kind tickets as a project sub-board (SpecsBoardView pinned).
      case 'specs':      return <ProjectSpecsBoard key={id} contractId={cid} {...shell}/>;
      case 'milestones': return <ProjectMilestoneTimeline key={id} milestones={milestones} {...shell}/>;
      case 'sessions':   return <ProjectSessions key={id} sessions={sessions} setRoute={setRoute} {...shell}/>;
      case 'streams':    return window.StreamsPanel ? <window.StreamsPanel key={id} contractId={cid}/> : null;
      default: return null;
    }
  };

  return (
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
            <span>{milestones.length} milestones</span>
            <span className="sep">·</span>
            <span style={{ color: 'var(--accent)' }}>{aliveSessions.length} live session{aliveSessions.length === 1 ? '' : 's'}</span>
            {project.auto && (<><span className="sep">·</span><span className="native-session-badge">auto</span></>)}
          </div>
        </div>
      </div>

      {order.map((id, i) => renderSection(id, {
        open: isOpen(id),
        onToggle: () => toggle(id),
        onMoveUp: () => move(id, -1),
        onMoveDown: () => move(id, +1),
        canUp: i > 0,
        canDown: i < order.length - 1,
      }))}
    </div>
  );
}

// ── 1. PLAN ──
function ProjectPlanSection({ plan, color, ...shell }) {
  if (!plan || !plan.total) {
    return (
      <PVSection title="Plan" {...shell}>
        <div className="pv-quiet-line">no <span className="mono">PLAN.md</span> — add one at the project root to track progress here.</div>
      </PVSection>
    );
  }
  const pct = Math.round((plan.done / plan.total) * 100);
  const barColor = color || 'var(--accent)';
  return (
    <PVSection {...shell} title={plan.title || 'Plan'} className="pv-plan"
      extra={
        <span className="pv-plan-stat">
          <span className="tnum">{plan.done}/{plan.total}</span>
          <span className="pv-plan-pct tnum" style={{ color: barColor }}>{pct}%</span>
        </span>
      }>
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
    </PVSection>
  );
}

// ── 2. TICKETS ──
function ProjectTrackerBoard({ contractId, ...shell }) {
  useStore();
  const [showArchived, setShowArchived] = usePVState(false);

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

  const tickets = window.Store.getTrackerTickets({ project_id: contractId, includeArchived: showArchived, exclude_kind: 'spec' });
  const base = window.TRACKER_COLUMNS || [];
  const cols = showArchived && window.TRACKER_ARCHIVED_COL ? [...base, window.TRACKER_ARCHIVED_COL] : base;

  const onNew = () => {
    window.Router.openComposer(contractId);
  };

  const Columns = window.TicketColumns;
  // Tools live OUTSIDE the toggle button (siblings) so clicking them doesn't
  // collapse the section.
  const tools = (
    <div className="pv-tracker-tools">
      <label className="tracker-toggle">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}/>
        Show archived
      </label>
      <button className="orch-btn primary" onClick={onNew}>+ New ticket</button>
    </div>
  );

  return (
    <PVSection {...shell} title="Tickets" count={tickets.length} className="pv-tracker" tools={tools}>
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
    </PVSection>
  );
}

// ── 2b. SPECS (TKT-0339) — a collapsible sub-board mounting SpecsBoardView
// pinned to the project (one component, two mounts — the same view the Tracker
// uses). Closed by default via PV_DEFAULT_COLLAPSED (TKT-0518).
function ProjectSpecsBoard({ contractId, ...shell }) {
  useStore();
  const specs = window.Store.getTrackerTickets({ project_id: contractId, kind: 'spec' });
  const count = specs.filter((s) => s.state !== 'archived').length;
  return (
    <PVSection {...shell} title="Specs" count={count}>
      {/* specs-board.jsx loads after project-view.jsx → reference via window at
          render time (defined by then). */}
      {window.SpecsBoardView ? React.createElement(window.SpecsBoardView, { projectId: contractId }) : null}
    </PVSection>
  );
}

// ── 3. MILESTONE TIMELINE ──
function ProjectMilestoneTimeline({ milestones, ...shell }) {
  const count = (milestones && milestones.length) || 0;
  if (count === 0) {
    return (
      <PVSection {...shell} title="Milestones" count={0}>
        <div className="pv-quiet-line">no milestones yet — sessions append them as work lands.</div>
      </PVSection>
    );
  }
  const ordered = [...milestones].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return (
    <PVSection {...shell} title="Milestones" count={count} className="pv-milestones">
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
    </PVSection>
  );
}

// ── 4. PROJECT SESSIONS ──
function ProjectSessions({ sessions, setRoute, ...shell }) {
  return (
    <PVSection {...shell} title="Sessions in this project" count={sessions.length}>
      {sessions.length === 0 ? (
        <div className="pv-quiet-line">
          no live session in this project.
        </div>
      ) : (
        <div className="native-sessions project-native-sessions">
          {sessions.map((s) => <AgentCard key={s.session_id || s.pid} session={s} setRoute={setRoute}/>)}
        </div>
      )}
    </PVSection>
  );
}

// v4: milestones are the primary progress signal.
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

window.ProjectView = ProjectView;
window.PVSection = PVSection;
window.MilestoneStrip = MilestoneStrip;
