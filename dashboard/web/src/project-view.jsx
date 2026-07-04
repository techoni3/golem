// Project view (v4) — the per-project command center.
//
// The hero leads, then six sections (Plan, Pending gates, Tickets, Specs,
// Milestones, Sessions) — each a collapsible, re-orderable PVSection (TKT-0518).
// Layout (order + collapsed) is PAGE-scoped (one layout for every project's
// detail page), persisted to localStorage. The v3 journal-synthesized agents
// panel, markdown tracker kanban, hook-event stream, and gate panels were
// removed in TKT-0009.

const { useState: usePVState } = React;

// ── TKT-0518: page-layout persistence ───────────────────────────────────────
// PAGE-scoped, not project-scoped: one layout for the project-detail page no
// matter which project is open (explicit product decision on the ticket).
const PV_LAYOUT_KEY = 'golem.pv.layout.v1';
const PV_SECTION_IDS = ['plan', 'repomap', 'gates', 'tickets', 'specs', 'milestones', 'sessions'];
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
// collapsed) so e.g. a collapsed Gates section still shows its "N awaiting" pulse.
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
      case 'repomap':    return <ProjectRepoMapSection key={id} project={project} {...shell}/>;
      // TKT-0194: human-in-the-loop approval / input gates. The anchor agent (or
      // any v4 agent) writes a gate file to ~/.config/golem/gates/<project_id>/
      // <gate_id>.md when a phase needs a human verdict; the dashboard exposes
      // the awaiting ones here with Approve / Deny / Cancel buttons.
      case 'gates':      return <ProjectGatesSection key={id} project={project} {...shell}/>;
      case 'tickets':    return <ProjectTrackerBoard key={id} contractId={cid} {...shell}/>;
      // TKT-0339: spec-kind tickets as a project sub-board (SpecsBoardView pinned).
      case 'specs':      return <ProjectSpecsBoard key={id} contractId={cid} {...shell}/>;
      case 'milestones': return <ProjectMilestoneTimeline key={id} milestones={milestones} {...shell}/>;
      case 'sessions':   return <ProjectSessions key={id} sessions={sessions} setRoute={setRoute} projectId={cid} {...shell}/>;
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

function ProjectRepoMapSection({ project, ...shell }) {
  const [busy, setBusy] = usePVState(false);
  const [force, setForce] = usePVState(false);
  const [budget, setBudget] = usePVState('8000');
  const [result, setResult] = usePVState(null);
  const [error, setError] = usePVState(null);
  const projectKey = project.project_id || project.id;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.SubstrateAPI.generateRepoMap(projectKey, { force, budget: Number(budget) || undefined });
      setResult(next);
    } catch (err) {
      setError(err?.payload?.error || err.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  const tools = (
    <div className="pv-tracker-tools">
      <label className="tracker-toggle">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={busy}/>
        Force
      </label>
      <input className="repo-map-budget" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={busy} inputMode="numeric" aria-label="Repo map budget"/>
      <button className="orch-btn primary" onClick={run} disabled={busy}>{busy ? 'Generating…' : 'Generate map'}</button>
    </div>
  );
  return (
    <PVSection title="Repo map" {...shell} tools={tools}>
      {!result && !error && <div className="pv-quiet-line">Generate an aider-backed orientation map cached under <span className="mono">~/.golem/repomap/</span>.</div>}
      {error && <div className="pv-quiet-line danger">{error}</div>}
      {result && (
        <div className="repo-map-result">
          <div><span className="muted">path</span> <span className="mono">{result.path || '(focused map not cached)'}</span></div>
          <div><span className="muted">commit</span> <span className="mono">{String(result.commit || '').slice(0, 7)}{result.dirty ? ' dirty' : ''}</span></div>
          <div><span className="muted">backend</span> <span className="mono">{result.backend || 'cache'}{result.runner ? ` via ${result.runner}` : ''}</span></div>
          {!!result.topFiles?.length && (
            <div className="repo-map-top">
              <span className="muted">top files</span>
              {result.topFiles.slice(0, 8).map((f) => <span key={f} className="native-session-badge mono">{f}</span>)}
            </div>
          )}
        </div>
      )}
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

  const tickets = window.Store.getTrackerTickets({ project_id: contractId, includeArchived: showArchived });
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

// ── 4. SESSIONS ──
function ProjectSessions({ sessions, setRoute, projectId, ...shell }) {
  return (
    <PVSection {...shell} title="Sessions in this project" count={sessions.length}>
      {sessions.length === 0 ? (
        <div className="pv-quiet-line">
          no live <span className="mono">claude</span> session in this project. Run <span className="mono">cd</span> into it and start one — it appears here automatically.
        </div>
      ) : (
        <div className="cc-session-list">
          {sessions.map((s) => <AgentCard key={s.session_id || s.pid} session={s} setRoute={setRoute}/>)}
        </div>
      )}
    </PVSection>
  );
}

// TKT-0194: pending human gates. The server returns the project's gate list
// on /api/projects (via the snapshot). Each gate carries frontmatter (kind,
// status, phase_just_completed, next_phase) + body. We render awaiting
// gates inline with Approve / Deny / Cancel buttons that POST to
// /api/projects/:id/gates/:gateId/:decision. After a verdict we refresh
// the projects list so the gate moves to the resolved list (or disappears
// if cancelled). For input gates, the body describes the missing secret.
function ProjectGatesSection({ project, ...shell }) {
  const allGates = (project && Array.isArray(project.gates)) ? project.gates : [];
  const awaiting = allGates.filter((g) => g.status === 'awaiting');
  const resolved = allGates.filter((g) => g.status !== 'awaiting');
  const [busyGateId, setBusyGateId] = usePVState(null);
  const [error, setError] = usePVState(null);
  // The "N awaiting" pulse badge stays visible when the section is collapsed
  // (it's in the head) — a collapsed Gates section must still scream.
  const badge = awaiting.length > 0 ? <span className="pv-section-title-badge pulse">{awaiting.length} awaiting</span> : null;

  if (allGates.length === 0) {
    return (
      <PVSection {...shell} title="Pending gates" count={0} badge={badge}>
        <div className="pv-quiet-line">
          no <span className="mono">~/.config/golem/gates/</span> files for this project. Agents write a gate here when a phase needs a human verdict (see <span className="mono">plugin/skills/gates/SKILL.md</span>).
        </div>
      </PVSection>
    );
  }

  const onVerdict = async (gateId, decision) => {
    setBusyGateId(gateId);
    setError(null);
    try {
      await window.SubstrateAPI.gateVerdict(project.project_id || project.id, gateId, decision);
      await window.Store.refreshProjects();
    } catch (err) {
      console.error('gate verdict failed', err);
      setError(err?.message || String(err));
    } finally {
      setBusyGateId(null);
    }
  };

  return (
    <PVSection {...shell} title="Pending gates" count={allGates.length} badge={badge}>
      {error && <div className="pv-section-error">verdict failed: {error}</div>}
      {awaiting.length > 0 && (
        <div className="pv-gates-awaiting">
          {awaiting.map((g) => (
            <div key={g.gateId} className="pv-gate pv-gate-awaiting">
              <div className="pv-gate-head">
                <span className="pv-gate-kind">{g.kind || 'approval'}</span>
                <span className="pv-gate-id mono">{g.gateId}</span>
                {g.phaseJustCompleted && (
                  <span className="pv-gate-phase">after <span className="mono">{g.phaseJustCompleted}</span></span>
                )}
                {g.nextPhase && (
                  <span className="pv-gate-phase">→ <span className="mono">{g.nextPhase}</span></span>
                )}
                {g.createdAt && (
                  <span className="pv-gate-ts mono">{g.createdAt.slice(0, 10)}</span>
                )}
              </div>
              {g.body && <div className="pv-gate-body">{renderGateBody(g.body)}</div>}
              <div className="pv-gate-actions">
                <button
                  className="orch-btn primary"
                  disabled={busyGateId === g.gateId}
                  onClick={() => onVerdict(g.gateId, 'approved')}
                >
                  {busyGateId === g.gateId ? '…' : 'Approve'}
                </button>
                <button
                  className="orch-btn ghost"
                  disabled={busyGateId === g.gateId}
                  onClick={() => onVerdict(g.gateId, 'denied')}
                >
                  Deny
                </button>
                <button
                  className="orch-btn ghost"
                  disabled={busyGateId === g.gateId}
                  onClick={() => onVerdict(g.gateId, 'cancelled')}
                >
                  Cancel
                </button>
                {g.path && (
                  <span className="pv-gate-path mono" title={g.path}>{g.path.replace(/^.*\/gates\//, 'gates/')}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {resolved.length > 0 && (
        <details className="pv-gates-resolved">
          <summary>
            <span>Resolved ({resolved.length})</span>
          </summary>
          <ul className="pv-gates-resolved-list">
            {resolved.map((g) => (
              <li key={g.gateId}>
                <span className={`pv-gate-status pv-gate-status-${g.status}`}>{g.status}</span>
                <span className="mono">{g.gateId}</span>
                {g.frontmatter && g.frontmatter.acted_at && (
                  <span className="pv-gate-ts mono">{String(g.frontmatter.acted_at).slice(0, 16).replace('T', ' ')}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </PVSection>
  );
}

// Render the gate body as a short list (gate files use ## headings + bullets).
// Plain JSX construction — never mutate .props.children, just build a new tree.
function renderGateBody(body) {
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith('# ')) {
      out.push(<div key={out.length} className="pv-gate-body-h1">{trimmed.slice(2)}</div>);
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      out.push(<div key={out.length} className="pv-gate-body-h2">{trimmed.slice(3)}</div>);
      i++;
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || (!t.startsWith('- ') && !t.startsWith('* '))) break;
        items.push(<li key={items.length}>{t.slice(2)}</li>);
        i++;
      }
      out.push(<ul key={out.length} className="pv-gate-body-ul">{items}</ul>);
      continue;
    }
    // Paragraph: collect consecutive non-blank, non-heading, non-bullet lines.
    const paraLines = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || t.startsWith('# ') || t.startsWith('## ') || t.startsWith('- ') || t.startsWith('* ')) break;
      paraLines.push(t);
      i++;
    }
    if (paraLines.length) {
      out.push(<p key={out.length} className="pv-gate-body-p">{paraLines.join(' ')}</p>);
    }
  }
  return <div className="pv-gate-body-rendered">{out}</div>;
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
