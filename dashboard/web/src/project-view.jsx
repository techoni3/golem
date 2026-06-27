// Project view (v4) — the per-project command center.
//
// Top-to-bottom the page leads with v4 progress objects only:
//
//   1. HERO            — name / glyph / counts.
//   2. PLAN            — live checklist from PLAN.md (N/M + bar), or one quiet
//                        line when the project has no plan.
//   3. TICKETS         — per-project tracker.db kanban.
//   4. MILESTONES      — this project's milestone timeline, newest first.
//   5. SESSIONS        — native Claude Code sessions in this project.
//
// The v3 journal-synthesized agents panel, markdown tracker kanban, hook-event
// stream, and gate panels were removed in TKT-0009.

const { useState: usePVState } = React;

function ProjectView({ projectId, tab, setRoute }) {
  useStore();
  const project = window.Store.getProject(projectId);

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

      {/* ── 1. PLAN ── */}
      <ProjectPlanSection plan={plan} color={project.color}/>

      {/* ── 2. TICKETS ── */}
      <ProjectTrackerBoard contractId={project.project_id || project.id}/>

      {/* ── 3. MILESTONE TIMELINE ── */}
      <ProjectMilestoneTimeline milestones={milestones}/>

      {/* ── 4. SESSIONS IN THIS PROJECT ── */}
      <ProjectSessions sessions={sessions} setRoute={setRoute} projectId={project.project_id || project.id}/>
    </div>
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

// ── 1. PLAN ──
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

// ── 2. TICKETS ──
function ProjectTrackerBoard({ contractId }) {
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

// ── 3. MILESTONE TIMELINE ──
function ProjectMilestoneTimeline({ milestones }) {
  if (!milestones || milestones.length === 0) {
    return (
      <div className="pv-section">
        <div className="pv-section-head"><span className="pv-section-title">Milestones</span></div>
        <div className="pv-quiet-line">no milestones yet — sessions append them as work lands.</div>
      </div>
    );
  }
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

// ── 4. SESSIONS ──
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
window.CollapsibleSection = CollapsibleSection;
window.MilestoneStrip = MilestoneStrip;
