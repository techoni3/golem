// Project view (v4) — unified 3-pane Spec Cockpit (GOL-14).
// Re-architected from collapsible PVSections into Spec Navigator | Document + Tasks | Swarm & Comments.
// Preserves hero, Store subscription, and WebSocket live updates.

const { useState: usePVState } = window.React;

// Keep legacy PV layout helpers for backward compat (not used in cockpit, but kept to avoid breakage if old keys exist)
const PV_LAYOUT_KEY = 'golem.pv.layout.v1';
const EmptyCard = window.EmptyCard || (({label, hint}) => window.React.createElement('div', {className:'empty-card'}, window.React.createElement('div', null, label), hint && window.React.createElement('div', {className:'empty-card-hint'}, hint)));

function pvLoadLayout() {
  try {
    const j = JSON.parse(localStorage.getItem(PV_LAYOUT_KEY) || '{}');
    return {
      order: Array.isArray(j.order) ? j.order : [],
      collapsed: (j.collapsed && typeof j.collapsed === 'object') ? j.collapsed : {},
    };
  } catch { return { order: [], collapsed: {} }; }
}

// ── Spec stage groupings for left navigator
const SPEC_STAGES = [
  { id: 'drafting', label: 'Drafting', icon: '📝', states: ['todo'], color: 'var(--status-open)' },
  { id: 'brainstorm', label: 'Brainstorm & Lock', icon: '🔒', states: ['in_progress'], color: 'var(--status-running)' },
  { id: 'building', label: 'In Build / Verifying', icon: '⚡', states: ['blocked', 'review'], color: 'var(--status-review)' },
  { id: 'closed', label: 'Closed', icon: '✅', states: ['done', 'archived'], color: 'var(--status-done)' },
];

function specStageFor(state) {
  for (const g of SPEC_STAGES) if (g.states.includes(state)) return g;
  return SPEC_STAGES[0];
}

function useActiveSpecId(projectId, specs) {
  const key = `golem.cockpit.activeSpec.${projectId}`;
  const [active, setActive] = window.React.useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved && specs.some(s => s.id === saved || s.display_id === saved)) return saved;
    } catch {}
    return specs[0]?.id || null;
  });
  // When specs list changes (new spec created / deleted), keep selection valid
  window.React.useEffect(() => {
    if (!specs.length) { setActive(null); return; }
    if (active && specs.some(s => s.id === active || s.display_id === active)) return;
    // Prefer last updated spec, or first in list
    const sorted = [...specs].sort((a,b) => (Date.parse(b.updated_at||b.created_at||'')||0) - (Date.parse(a.updated_at||a.created_at||'')||0));
    const next = sorted[0]?.id || specs[0].id;
    setActive(next);
    try { localStorage.setItem(key, next); } catch {}
  }, [specs, active, key]);
  const set = (id) => {
    setActive(id);
    try { localStorage.setItem(key, id); } catch {}
  };
  return [active, set];
}

// ── Helpers
function fmtAgo(iso) { return window.SubstrateFmt?.fmtTimeAgo?.(iso) || ''; }
function fmtClock(iso) { return window.SubstrateFmt?.fmtClock?.(iso) || iso || ''; }
function renderMd(text) {
  if (!text) return '';
  return window.SubstrateFmt?.renderMarkdown ? window.SubstrateFmt.renderMarkdown(text) : String(text);
}
function authorMeta(author, labelHint) {
  if (author === 'human' || author === 'you' || author === 'human:dashboard') return { label: 'Lavee', color: '#f5a623' };
  if (labelHint) return { label: labelHint, color: '#9aa4bb' };
  const s = window.Store?.getNativeSessionById?.(author);
  if (s?.label || s?.name) return { label: s.label || s.name, color: '#9aa4bb' };
  return { label: author || 'Agent', color: '#9aa4bb' };
}
function nextStateFor(state) {
  const order = { todo: 'in_progress', in_progress: 'review', review: 'done', done: 'todo', blocked: 'in_progress', archived: 'todo' };
  return order[state] || 'todo';
}
function roleGlyph(role) {
  const r = String(role||'').toLowerCase();
  if (r==='designer') return 'DS';
  if (r==='builder') return 'BU';
  if (r==='explorer') return 'EX';
  if (r==='lead') return 'LE';
  if (r==='reviewer') return 'RE';
  return r.slice(0,2).toUpperCase() || 'AG';
}
function statePillClass(state) {
  const map = { todo: 'idle', in_progress: 'running', blocked: 'blocked', review: 'review', done: 'done', archived: 'done' };
  return map[state] || 'idle';
}

// ── ProjectView — 3-pane cockpit
function ProjectView({ projectId, tab, setRoute }) {
  (window.useStore ? window.useStore() : null);
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
  const cid = project.project_id || project.id;
  const milestones = project.milestones || [];
  const [directiveOpen, setDirectiveOpen] = window.React.useState(false);
  const [peekSessionId, setPeekSessionId] = window.React.useState(null);
  const [spawnOpen, setSpawnOpen] = window.React.useState(false);
  window.React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDirectiveOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const aliveSessions = window.Store.getProjectAliveSessions(project);
  // Canonical truth engine — hero progress derived from tracker tickets, not PLAN.md (fixes 5/5 vs 6/9 contradiction)
  const allProjectTickets = window.Store.getTrackerTickets({ project_id: cid, includeArchived: true });
  const canonicalTotal = allProjectTickets.filter(t => t.kind !== 'spec' && t.state !== 'archived').length;
  const canonicalDone = allProjectTickets.filter(t => t.kind !== 'spec' && t.state === 'done').length;
  const canonicalPct = canonicalTotal ? Math.round((canonicalDone / canonicalTotal) * 100) : 0;
  const plan = project.plan;

  // Specs derived from canonical ticket set (P0)
  const totalTasks = allProjectTickets.filter(t => t.kind === 'task').length;
  const doneTasks = allProjectTickets.filter(t => t.kind === 'task' && t.state === 'done').length;
  const allSpecs = allProjectTickets.filter(t => t.kind === 'spec');
  // Sort specs by updated_at desc for tree default ordering
  const specsSorted = window.React.useMemo(() => {
    return [...allSpecs].sort((a,b) => (Date.parse(b.updated_at||b.created_at||'')||0) - (Date.parse(a.updated_at||a.created_at||'')||0));
  }, [allSpecs]);
  const [activeSpecId, setActiveSpecId] = useActiveSpecId(cid, specsSorted);
  const activeSpec = window.React.useMemo(() => {
    if (!activeSpecId) return null;
    return specsSorted.find(s => s.id === activeSpecId || s.display_id === activeSpecId) || specsSorted[0] || null;
  }, [activeSpecId, specsSorted]);

  // Lifecycle-Aware Next Action CTA (P1)
  const nextAction = window.React.useMemo(() => {
    if (!activeSpec) {
      if (allSpecs.length === 0) {
        return {
          icon: '🚀',
          title: 'Start First Flight',
          desc: 'Create your first living spec to begin agentic development',
          cta: 'Create First Spec',
          run: () => window.Router?.openComposer?.(cid, { kind: 'spec' }),
        };
      }
      return {
        icon: '📝',
        title: 'Select a Spec',
        desc: 'Choose an active spec from the left tree to review or dispatch',
        cta: 'View First Spec',
        run: () => allSpecs[0] && setActiveSpecId(allSpecs[0].display_id || allSpecs[0].id),
      };
    }
    const specTickets = allProjectTickets.filter(t => t.parent_id === activeSpec.id);
    const specComments = window.Store.getTicketComments(activeSpec.id) || [];
    const openComments = specComments.filter(c => c.status === 'open' && c.dispatch_state !== 'addressed');
    const todoTasks = specTickets.filter(t => t.state === 'todo');
    const inProgTasks = specTickets.filter(t => t.state === 'in_progress');
    const reviewTasks = specTickets.filter(t => t.state === 'review');
    const doneTasksCount = specTickets.filter(t => t.state === 'done').length;

    if (activeSpec.state === 'todo') {
      return {
        icon: '📝',
        title: 'Draft & Decompose',
        desc: 'Define acceptance criteria and break down into executable tasks',
        cta: '⚡ Decompose Tasks',
        run: () => window.Router?.openComposer?.(cid, { kind: 'task', parent: activeSpec.id }),
      };
    }
    if (openComments.length > 0) {
      return {
        icon: '💬',
        title: `Resolve Feedback (${openComments.length} Open)`,
        desc: `${openComments.length} comment${openComments.length === 1 ? '' : 's'} awaiting resolution or dispatch`,
        cta: 'Review Comments ➔',
        run: () => {
          const el = document.querySelector('.cockpit-comments-section');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      };
    }
    if (todoTasks.length > 0 && inProgTasks.length === 0) {
      return {
        icon: '🚀',
        title: `Launch Swarm (${todoTasks.length} Tasks Ready)`,
        desc: `Dispatch queued subtasks to available workers in isolated worktrees`,
        cta: 'Talk to Lead ⌘K',
        run: () => setDirectiveOpen(true),
      };
    }
    if (reviewTasks.length > 0) {
      return {
        icon: '🔍',
        title: `Verify Work (${reviewTasks.length} in Review)`,
        desc: `${reviewTasks.length} task${reviewTasks.length === 1 ? '' : 's'} ready for evidence check and verification`,
        cta: 'Review Tasks ➔',
        run: () => {
          const el = document.querySelector('.task-subtable');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      };
    }
    if (activeSpec.state !== 'done' && activeSpec.state !== 'archived') {
      if (specTickets.length > 0 && doneTasksCount === specTickets.length) {
        return {
          icon: '✓',
          title: 'All Tasks Shipped',
          desc: 'All subtasks complete — verify evidence and land spec',
          cta: 'Verify & Land Spec',
          run: () => {
            window.SubstrateAPI?.updateTicket(activeSpec.display_id || activeSpec.id, { state: 'done', actor: 'human:dashboard' })
              .then(u => { if (u && u.id) window.Store.upsertTrackerTicket(u); });
          },
        };
      }
    }
    return {
      icon: '✅',
      title: 'Spec Complete',
      desc: 'All work items verified and landed on branch',
      cta: '+ New Spec',
      run: () => window.Router?.openComposer?.(cid, { kind: 'spec' }),
    };
  }, [activeSpec?.id, activeSpec?.state, allProjectTickets.length, allSpecs.length, cid]);

  return (
    <div className="page project-cockpit-page">
      <div className="project-hero cockpit-hero">
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
            <span style={{ color: 'var(--accent)' }}>{aliveSessions.length} live worker{aliveSessions.length === 1 ? '' : 's'}</span>
            <span className="sep">·</span><span className="mono" title="Canonical tracker truth">{canonicalDone}/{canonicalTotal} tasks</span><span className="mono" style={{color: project.color}}>{canonicalPct}%</span>
          </div>
        </div>
        <div className="cockpit-hero-actions">
          <button className="orch-btn ghost small" onClick={()=> setDirectiveOpen(true)} title="Talk to Lead (Cmd+K)">💬 Talk to Lead <span className="mono" style={{opacity:.6, marginLeft:6}}>⌘K</span></button>
          <button className="orch-btn small" onClick={()=> setSpawnOpen(true)} title="Add worker">+ Add Worker</button>
        </div>
      </div>

      {/* Lifecycle-Aware Next Action Header CTA (P1) */}
      {nextAction && (
        <div className="cockpit-next-action-bar">
          <div className="cockpit-next-action-left">
            <span className="cockpit-next-action-icon">{nextAction.icon}</span>
            <div className="cockpit-next-action-text">
              <span className="cockpit-next-action-title">Next: {nextAction.title}</span>
              <span className="cockpit-next-action-desc">{nextAction.desc}</span>
            </div>
          </div>
          {nextAction.cta && nextAction.run && (
            <button className="orch-btn primary small cockpit-next-action-btn" onClick={nextAction.run}>
              {nextAction.cta}
            </button>
          )}
        </div>
      )}

      <NextActionBanner project={project} cid={cid} activeSpec={activeSpec} specs={specsSorted} />
      <div className="cockpit-grid">
        <CockpitLeft project={project} cid={cid} specs={specsSorted} activeSpec={activeSpec} setActiveSpecId={setActiveSpecId} />
        <CockpitCenter project={project} cid={cid} activeSpec={activeSpec} setRoute={setRoute} />
        <CockpitRight project={project} cid={cid} activeSpec={activeSpec} setRoute={setRoute} onPeek={setPeekSessionId} onSpawn={()=> setSpawnOpen(true)} />
      </div>
      {directiveOpen && window.DirectiveModal && window.React.createElement(window.DirectiveModal, { open: directiveOpen, onClose: ()=> setDirectiveOpen(false), projectId: cid, defaultSpecId: activeSpec?.display_id || activeSpec?.id || null })}
      {peekSessionId && window.PeekModal && window.React.createElement(window.PeekModal, { open: !!peekSessionId, sessionId: peekSessionId, onClose: ()=> setPeekSessionId(null) })}
      {spawnOpen && window.WorkerSpawnModal && window.React.createElement(window.WorkerSpawnModal, { open: spawnOpen, onClose: ()=> setSpawnOpen(false), defaultProjectId: cid })}
    </div>
  );
}

// ── Next Action Banner — lifecycle-aware CTA (P1)
function NextActionBanner({ project, cid, activeSpec, specs }) {
  const spec = activeSpec ? (window.Store.getState().trackerTickets.get(activeSpec.id) || activeSpec) : null;
  if (!spec) return null;
  const allChildren = window.Store.getTrackerTickets({ project_id: cid, includeArchived: true }).filter(t => t.parent_id === spec.id);
  const comments = window.Store.getTicketComments(spec.id) || [];
  const openUndispatched = comments.filter(c => c.status === 'open' && c.dispatch_state === 'undispatched');
  const todoTasks = allChildren.filter(t => t.state === 'todo');
  const reviewTasks = allChildren.filter(t => t.state === 'review' || t.state === 'done');
  // Determine next action
  let action = null;
  if (spec.state === 'todo' && allChildren.length === 0) {
    action = { icon: '📝', label: 'Next Action: Decompose Spec into Tasks', cta: 'Decompose', onClick: () => window.Router.openComposer(cid, { kind: 'task', parent: spec.display_id || spec.id }) };
  } else if (openUndispatched.length > 0) {
    action = { icon: '💬', label: `Next Action: Resolve ${openUndispatched.length} Open Feedback Items`, cta: 'Review Comments', onClick: () => { const el = document.querySelector('.cockpit-comments-section'); if (el) el.scrollIntoView({ behavior: 'smooth' }); } };
  } else if (todoTasks.length > 0) {
    action = { icon: '🚀', label: `Next Action: Dispatch ${todoTasks.length} Tasks to Workers`, cta: 'Dispatch', onClick: () => { const first = todoTasks[0]; if (first) window.SubstrateAPI.dispatchTicket(first.display_id||first.id, { session_id: (window.Store.getProjectAliveSessions(project)[0]?.session_id||''), note: 'Next Action dispatch', mode: 'now' }).catch(()=>{}); } };
  } else if (reviewTasks.length > 0 || allChildren.length > 0) {
    action = { icon: '✓', label: 'Next Action: Verify Evidence & Land Spec', cta: 'Verify & Land', onClick: () => { if (confirm(`Mark ${spec.display_id||spec.id} as done?`)) window.SubstrateAPI.updateTicket(spec.display_id||spec.id, { state: 'done', actor: 'human:dashboard' }).then(u=> u&&u.id&&window.Store.upsertTrackerTicket(u)); } };
  } else {
    return null;
  }
  return (
    <div className="next-action-banner">
      <span className="next-action-icon">{action.icon}</span>
      <span className="next-action-label">{action.label}</span>
      <button className="orch-btn primary small next-action-cta" onClick={action.onClick}>{action.cta} →</button>
    </div>
  );
}

// ── LEFT: Spec Lifecycle Navigator
function CockpitLeft({ project, cid, specs, activeSpec, setActiveSpecId }) {
  const [query, setQuery] = window.React.useState('');
  const [ideasCount, setIdeasCount] = window.React.useState(0);
  const qLower = query.trim().toLowerCase();
  // Refresh ideas count for this project
  window.React.useEffect(() => {
    let cancelled = false;
    const fetch = () => window.SubstrateAPI.listIdeas(cid).then(rows => { if (!cancelled) setIdeasCount(Array.isArray(rows) ? rows.length : 0); }).catch(()=>{});
    fetch();
    const onChange = () => fetch();
    window.addEventListener('ideas:changed', onChange);
    return () => { cancelled = true; window.removeEventListener('ideas:changed', onChange); };
  }, [cid]);

  // Filter specs by query (title / display_id)
  const filtered = window.React.useMemo(() => {
    if (!qLower) return specs;
    return specs.filter(s =>
      (s.title||'').toLowerCase().includes(qLower) ||
      (s.display_id||'').toLowerCase().includes(qLower) ||
      (s.id||'').toLowerCase().includes(qLower)
    );
  }, [specs, qLower]);

  // Group filtered specs by stage
  const grouped = window.React.useMemo(() => {
    const map = new Map(SPEC_STAGES.map(g => [g.id, []]));
    for (const s of filtered) {
      const g = specStageFor(s.state);
      map.get(g.id).push(s);
    }
    return map;
  }, [filtered]);

  // For each spec, compute task progress and unaddressed count
  const specMeta = window.React.useMemo(() => {
    const m = new Map();
    // All child tickets for this project (non-spec)
    const allChildren = window.Store.getTrackerTickets({ project_id: cid, includeArchived: true }).filter(t => t.parent_id);
    for (const s of specs) {
      const children = allChildren.filter(c => c.parent_id === s.id);
      const total = children.length;
      const done = children.filter(c => c.state === 'done' || c.state === 'archived').length;
      const comments = window.Store.getTicketComments(s.id) || [];
      const openUndispatched = comments.filter(c => c.status === 'open' && c.dispatch_state === 'undispatched').length;
      const openTotal = comments.filter(c => c.status === 'open').length;
      m.set(s.id, { total, done, openUndispatched, openTotal, children });
    }
    return m;
  }, [specs, cid, window.Store.getState().trackerTickets, window.Store.getState().ticketComments]);

  return (
    <div className="cockpit-left">
      <div className="cockpit-left-head">
        <button className="orch-btn primary cockpit-ideas-btn" onClick={() => window.Router.openIdeas()} title="Open project ideas">
          <span>💡 Ideas</span>
          {ideasCount > 0 && <span className="cockpit-ideas-count">{ideasCount}</span>}
        </button>
        <button className="orch-btn ghost cockpit-new-spec" onClick={() => window.Router.openComposer(cid, { kind: 'spec' })} title="New spec">+ Spec</button>
      </div>
      <div className="cockpit-search-wrap">
        <input
          className="cockpit-search"
          placeholder="Filter specs…"
          value={query}
          onChange={(e)=> setQuery(e.target.value)}
          aria-label="Filter specs"
        />
      </div>
      <div className="cockpit-tree">
        {SPEC_STAGES.map(group => {
          const list = grouped.get(group.id) || [];
          return (
            <div key={group.id} className="cockpit-stage-group">
              <div className="cockpit-stage-head">
                <span className="cockpit-stage-label"><span className="cockpit-stage-icon">{group.icon}</span> {group.label}</span>
                <span className="cockpit-stage-count tnum">{list.length}</span>
              </div>
              {list.length === 0 ? (
                <div className="cockpit-stage-empty">—</div>
              ) : list.map(s => {
                const meta = specMeta.get(s.id) || { total:0, done:0, openUndispatched:0, openTotal:0 };
                const active = activeSpec && (activeSpec.id === s.id || activeSpec.display_id === s.display_id);
                return (
                  <button
                    key={s.id}
                    className={`cockpit-spec-item ${active ? 'active' : ''}`}
                    onClick={()=> setActiveSpecId(s.id)}
                    title={`${s.display_id||s.id}: ${s.title}`}
                  >
                    <span className="cockpit-spec-indicator" style={{ background: group.color }}/>
                    <span className="cockpit-spec-main">
                      <span className="cockpit-spec-id mono">{s.display_id || s.id}</span>
                      <span className="cockpit-spec-title">{s.title}</span>
                    </span>
                    <span className="cockpit-spec-badges">
                      {meta.total > 0 && <span className="cockpit-pill cockpit-task-pill" title={`${meta.done}/${meta.total} tasks done`}>{meta.done}/{meta.total}</span>}
                      {meta.openUndispatched > 0 && <span className="cockpit-pill cockpit-comment-pill" title={`${meta.openUndispatched} undispatched`}>{meta.openUndispatched}💬</span>}
                      {meta.openUndispatched === 0 && meta.openTotal > 0 && <span className="cockpit-pill cockpit-comment-pill quiet" title={`${meta.openTotal} open`}>{meta.openTotal}💬</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {specs.length === 0 ? (
          window.EmptyStateOnboardingCTA ? window.React.createElement(window.EmptyStateOnboardingCTA, { kind: 'specs', setRoute: () => window.Router && window.Router.go({ kind: 'onboarding' }) }) : <div className="cockpit-empty">No specs yet — create one with + Spec.</div>
        ) : filtered.length === 0 ? (
          <div className="cockpit-empty">No specs match filter.</div>
        ) : null}
      </div>
    </div>
  );
}

// ── CENTER: Spec Document + Sub-tasks + Action Bar
function CockpitCenter({ project, cid, activeSpec, setRoute }) {
  (window.useStore ? window.useStore() : null);
  const spec = activeSpec ? (window.Store.getState().trackerTickets.get(activeSpec.id) || activeSpec) : null;
  const [dispatchable, setDispatchable] = window.React.useState([]);
  const bodyRef = window.React.useRef(null);

  window.React.useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    window.SubstrateAPI.listDispatchable(cid).then(list => { if (!cancelled) setDispatchable(Array.isArray(list)?list:[]); }).catch(()=>{});
    return () => { cancelled = true; };
  }, [cid]);

  // Ensure active spec details are loaded (body + comments)
  window.React.useEffect(() => {
    if (!activeSpec) return;
    const id = activeSpec.display_id || activeSpec.id;
    window.SubstrateAPI.getTicket(id).then(full => {
      if (full && full.id) {
        window.Store.upsertTrackerTicket(full);
        window.Store.seedTicketComments(full.id, full.comments||[]);
      }
    }).catch(()=>{});
  }, [activeSpec?.id, activeSpec?.display_id]);

  // Mermaid rendering after body inject
  window.React.useEffect(() => {
    if (!activeSpec || !bodyRef.current) return;
    const nodes = bodyRef.current.querySelectorAll('.mermaid');
    if (nodes.length && window.runMermaid) window.runMermaid(nodes);
  }, [activeSpec?.body, activeSpec?.id]);

  // Highlight quoted text ranges for anchored comments (keeps inline annotations interactive)
  window.React.useEffect(() => {
    if (!activeSpec || !bodyRef.current) return;
    const root = bodyRef.current;
    // Clear previous highlights
    root.querySelectorAll('mark.cockpit-anno').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
    const comments = window.Store.getTicketComments(spec.id) || [];
    const quotes = comments.filter(c => c.quote && c.status !== 'deleted').slice(0, 20);
    if (!quotes.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentNode;
        if (p && p.closest && p.closest('mark.cockpit-anno')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    const fullText = textNodes.map(t => t.nodeValue).join('');
    // Build node offset index
    let pos = 0;
    const idx = textNodes.map(t => {
      const start = pos;
      pos += t.nodeValue.length;
      return { node: t, start, end: pos };
    });
    for (const c of quotes) {
      const q = String(c.quote).trim();
      if (!q) continue;
      let at = fullText.indexOf(q);
      if (at < 0) {
        // Fallback: case-insensitive
        at = fullText.toLowerCase().indexOf(q.toLowerCase());
      }
      if (at < 0) continue;
      const start = at, end = at + q.length;
      // Wrap range across text nodes
      for (let i = idx.length - 1; i >= 0; i--) {
        const seg = idx[i];
        if (seg.end <= start || seg.start >= end) continue;
        let node = seg.node;
        const ls = Math.max(0, start - seg.start);
        const le = Math.min(node.nodeValue.length, end - seg.start);
        if (le < node.nodeValue.length) node.splitText(le);
        if (ls > 0) node = node.splitText(ls);
        const mark = document.createElement('mark');
        mark.className = 'cockpit-anno';
        mark.dataset.commentId = c.id;
        mark.title = 'Comment: ' + (c.body||'').slice(0,80);
        mark.style.background = 'color-mix(in oklab, var(--status-review) 22%, transparent)';
        mark.style.borderBottom = '2px solid var(--status-review)';
        mark.style.cursor = 'pointer';
        node.parentNode.insertBefore(mark, node);
        mark.appendChild(node);
        mark.addEventListener('click', () => {
          const el = document.querySelector(`[data-comment-id="${c.id}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Highlight right pane comment
          const card = document.querySelector(`.cockpit-comment[data-comment-id="${c.id}"]`);
          if (card) { card.style.outline = '2px solid var(--accent)'; setTimeout(()=> card.style.outline='', 1200); }
        });
      }
    }
  }, [activeSpec?.id, spec.id, spec.body, (window.Store.getTicketComments(spec.id)||[]).length]);

  if (!activeSpec || !spec) {
    const hasAnySpecs = window.Store.getTrackerTickets({ project_id: cid, kind: 'spec' }).length > 0;
    if (!hasAnySpecs) {
      return (
        <div className="cockpit-center">
          {window.EmptyStateOnboardingCTA ? window.React.createElement(window.EmptyStateOnboardingCTA, { kind: 'specs' }) : <EmptyCard label="no specs yet" hint={<>Create your first living spec to populate the cockpit center.</>} />}
        </div>
      );
    }
    return (
      <div className="cockpit-center">
        <EmptyCard label="no spec selected" hint={<>Select a spec from the left navigator or create a new one with <span className="mono">+ Spec</span>.</>} />
      </div>
    );
  }

  const allTickets = window.Store.getTrackerTickets({ project_id: cid, includeArchived: true });
  const children = allTickets.filter(t => t.parent_id === spec.id);
  const comments = window.Store.getTicketComments(spec.id) || [];
  const openUndispatched = comments.filter(c => c.status==='open' && c.dispatch_state==='undispatched');

  const stateOrder = { todo:'Draft', in_progress:'Refining', blocked:'Blocked', review:'Review', done:'Locked', archived:'Locked' };
  const html = renderMd(spec.body || '');
  // Lifecycle stage for doc-lifecycle-bar (4 pills)
  const lifecycle = (() => {
    const s = spec.state;
    if (s === 'todo') return { active: 1, done: [] };
    if (s === 'in_progress') return { active: 2, done: [1] };
    if (s === 'blocked' || s === 'review') return { active: 3, done: [1,2] };
    if (s === 'done' || s === 'archived') return { active: 4, done: [1,2,3] };
    return { active: 1, done: [] };
  })();
  const pillClass = (n) => lifecycle.done.includes(n) ? 'done' : lifecycle.active===n ? 'active' : '';

  const labelBySession = new Map(dispatchable.map(s => [s.session_id, s.label]));

  const handleTaskState = (task) => {
    const next = nextStateFor(task.state);
    window.SubstrateAPI.updateTicket(task.display_id || task.id, { state: next, actor: 'human:dashboard' })
      .then(updated => { if (updated && updated.id) window.Store.upsertTrackerTicket(updated); })
      .catch(err => console.error('task state update failed', err));
  };

  const dispatchOpen = () => {
    if (openUndispatched.length===0) return;
    const target = spec.assignee && dispatchable.some(s=>s.session_id===spec.assignee) ? spec.assignee : (dispatchable[0]?.session_id || '');
    if (!target) { alert('No live session to dispatch to. Start a worker via Swarm pane or /agents.'); return; }
    window.SubstrateAPI.batchDispatchComments(spec.display_id||spec.id, { session_id: target })
      .then(res => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
      }).catch(err=> console.error(err));
  };

  const decompose = () => {
    window.Router.openComposer(cid, { kind: 'task', parent: spec.display_id || spec.id });
  };

  const verifyAndLand = () => {
    if (!confirm(`Mark spec ${spec.display_id||spec.id} as done (Locked)?`)) return;
    window.SubstrateAPI.updateTicket(spec.display_id||spec.id, { state: 'done', actor: 'human:dashboard' })
      .then(updated => { if (updated?.id) window.Store.upsertTrackerTicket(updated); })
      .catch(err=> console.error(err));
  };

  return (
    <div className="cockpit-center">
      <div className="doc-header">
        <div className="doc-lifecycle-bar">
          <span className={`step-pill ${pillClass(1)}`}>1. Draft {lifecycle.done.includes(1) ? '✓' : ''}</span>
          <span className="step-arrow">➔</span>
          <span className={`step-pill ${pillClass(2)}`}>2. Lock {lifecycle.done.includes(2) ? '✓' : ''}</span>
          <span className="step-arrow">➔</span>
          <span className={`step-pill ${pillClass(3)}`}>3. In Build {lifecycle.active===3 ? `(${children.filter(c=>c.state==='done').length}/${children.length})` : lifecycle.done.includes(3) ? '✓' : ''}</span>
          <span className="step-arrow">➔</span>
          <span className={`step-pill ${pillClass(4)}`}>4. Complete {lifecycle.done.includes(4) || lifecycle.active===4 ? '✓' : ''}</span>
        </div>
        <div className="cockpit-doc-head">
          <div className="cockpit-doc-id mono">{spec.display_id || spec.id}</div>
          <span className={`pill ${statePillClass(spec.state)}`}>{stateOrder[spec.state]||spec.state}</span>
          <span className="cockpit-doc-title">{spec.title}</span>
        </div>
        <div className="cockpit-doc-meta">
          <span className="mono">{spec.kind}</span>
          <span>·</span>
          <span>updated {fmtAgo(spec.updated_at)}</span>
          {spec.assignee && <><span>·</span><span>assignee {labelBySession.get(spec.assignee)||spec.assignee_label||spec.assignee.slice(0,8)}</span></>}
        </div>
      </div>
      <div className="cockpit-doc-body td-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="cockpit-subtasks task-subtable">
        <div className="cockpit-subtasks-head">
          <span className="cockpit-subtasks-title">Sub-tasks</span>
          <span className="cockpit-subtasks-count tnum">{children.length}</span>
          <button className="orch-btn ghost small" onClick={decompose}>+ Task</button>
        </div>
        {children.length===0 ? (
          <div className="cockpit-quiet">No sub-tasks yet. Decompose this spec to create work items.</div>
        ) : (
          <div className="cockpit-task-table">
            {children.map(t => {
              const statusCls = t.state==='done' ? 'status-done' : t.state==='in_progress' ? 'status-inprogress' : 'status-todo';
              const branch = t.branch || (t.worktree ? t.worktree.split('/').pop() : null) || null;
              const assigneeLabel = t.assignee_label || labelBySession.get(t.assignee) || (t.assignee? t.assignee.slice(0,8): null);
              const avatarGlyph = t.assignee ? (assigneeLabel||'?').slice(0,2).toUpperCase() : '—';
              const doneAt = t.done_at || t.state_changed_at || null;
              const actorLabel = t.state==='done' ? (t.assignee_label || labelBySession.get(t.assignee) || (t.assignee?String(t.assignee).slice(0,8):'')) : null;
              return (
                <div key={t.id} className="task-row">
                  <div className="task-row-left">
                    <button className={`task-status-pill ${statusCls}`} onClick={()=>{ handleTaskState(t); // also patch spec checklist in next tick
                      setTimeout(()=> {
                        try {
                          const specTicket = window.Store.getState().trackerTickets.get(spec.id);
                          if (!specTicket) return;
                          let body = specTicket.body || '';
                          // Find checklist line for this task and toggle checkbox
                          const id = t.display_id || t.id;
                          const title = t.title || '';
                          // Simple heuristic: look for "- [ ]" line containing display_id or title
                          const lines = body.split('\n');
                          let changed = false;
                          for (let i=0;i<lines.length;i++) {
                            const line = lines[i];
                            if (line.includes(id) || (title && line.includes(title.slice(0,20)))) {
                              if (t.state !== 'done' && line.match(/- \[ \]/)) { lines[i] = line.replace('- [ ]', '- [x]'); changed = true; break; }
                              if (t.state === 'done' && line.match(/- \[x\]/i)) { lines[i] = line.replace(/- \[x\]/i, '- [ ]'); changed = true; break; }
                            }
                          }
                          if (changed) {
                            const newBody = lines.join('\n');
                            window.SubstrateAPI.updateTicket(spec.display_id||spec.id, { body: newBody, actor: 'human:dashboard' }).then(u=> u&&u.id&&window.Store.upsertTrackerTicket(u));
                          }
                        } catch {}
                      }, 300);
                    }} title="Click to cycle state">{t.state==='in_progress' ? 'In Progress' : t.state==='review' ? 'Review' : t.state==='done' ? 'Done' : t.state==='blocked' ? 'Blocked' : 'Todo'}</button>
                    <a className="mono cockpit-task-id" href={window.Router.buildHref({kind:'ticket', id:t.id})} onClick={(e)=>{e.preventDefault(); window.Router.openTicket(t.id);}} style={{fontWeight:500}}>{t.display_id||t.id}</a>
                    <span className="cockpit-task-title" title={t.title} style={{fontWeight:500}}>{t.title}</span>
                  </div>
                  <div className="task-row-right" style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    {assigneeLabel && <span className="worker-avatar" style={{width:22,height:22,fontSize:9}}>{avatarGlyph}</span>}
                    <span className="mono" style={{fontSize:11,color:'var(--text-3)'}}>{assigneeLabel || 'Unassigned'}</span>
                    {branch && <span className="branch-chip">{branch}</span>}
                    <span className={`pill ${statePillClass(t.state)}`} style={{fontSize:10}}>{t.state}</span>
                    {t.state==='done' && doneAt && <span className="mono" style={{fontSize:10,color:'var(--text-3)'}} title={doneAt}>{window.SubstrateFmt?.fmtTimeAgo?.(doneAt)||''} ✓</span>}
                    {t.state==='done' && actorLabel && <span className="mono" style={{fontSize:10,background:'var(--bg-3)',border:'1px solid var(--border-1)',padding:'1px 5px',borderRadius:4}}>{actorLabel}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="cockpit-actions">
        <button className="orch-btn cockpit-action" onClick={decompose} title="Lead: Decompose spec into tasks">⚡ Decompose into Tasks</button>
        <button className="orch-btn cockpit-action primary" onClick={dispatchOpen} disabled={openUndispatched.length===0} title="Dispatch all undispatched comments on this spec">
          🚀 Dispatch Open Comments {openUndispatched.length>0 ? `(${openUndispatched.length})` : ''}
        </button>
        <button className="orch-btn cockpit-action" onClick={verifyAndLand} title="Verify & land spec (mark done)">✓ Verify & Land Spec</button>
      </div>
    </div>
  );
}

// ── RIGHT: Swarm Ops & Comments
function CockpitRight({ project, cid, activeSpec, onPeek, onSpawn }) {
  (window.useStore ? window.useStore() : null);
  const [filter, setFilter] = window.React.useState('open'); // open | decision | dispatched | resolved | all
  const alive = window.Store.getProjectAliveSessions(project);
  const spec = activeSpec ? (window.Store.getState().trackerTickets.get(activeSpec.id) || activeSpec) : null;
  const allComments = spec ? (window.Store.getTicketComments(spec.id) || []) : [];
  const comments = window.React.useMemo(() => {
    if (filter === 'all') return allComments;
    if (filter === 'decision') return allComments.filter(c => c.tag === 'decision' || c.tag === 'decision_ask' || /decision|choice|locked/i.test(c.body||''));
    if (filter === 'dispatched') return allComments.filter(c => c.dispatch_state === 'dispatched');
    if (filter === 'resolved') return allComments.filter(c => c.status === 'resolved' || c.dispatch_state === 'addressed');
    return allComments.filter(c => c.status === 'open' && c.dispatch_state !== 'addressed');
  }, [allComments, filter]);

  // Decision Summary box (locked architectural choices on the spec)
  const decisionSummary = window.React.useMemo(() => {
    if (!allComments.length) return null;
    const decisions = allComments.filter(c => (c.tag === 'decision' || c.tag === 'decision_ask' || /decision|locked/i.test(c.body||'')));
    if (!decisions.length) return null;
    return decisions.slice(0, 3);
  }, [allComments]);

  // Tick for pulsing timer (re-render every 2s to update elapsed)
  const [, tick] = window.React.useState(0);
  window.React.useEffect(()=>{ const id=setInterval(()=>tick(n=>n+1),2000); return ()=>clearInterval(id); },[]);

  const handlePeek = (session) => {
    if (session.session_id && onPeek) { onPeek(session.session_id); return; }
    if (session.session_id) window.Router.openNativeSession(session.session_id);
  };
  const handleSteer = (session) => {
    const msg = prompt(`Send guidance to ${session.name||session.session_id.slice(0,8)}:`);
    if (!msg || !msg.trim()) return;
    window.SubstrateAPI.pushBrief(msg.trim(), session.session_id).catch(err=> console.error(err));
  };

  return (
    <div className="cockpit-right">
      <div className="cockpit-right-section">
        <div className="cockpit-right-head">
          <span className="cockpit-right-title">Live Workers</span>
          <span className="cockpit-right-count tnum">{alive.length}</span>
          <button className="orch-btn ghost small" onClick={()=> onSpawn && onSpawn()} title="Add worker" style={{marginLeft:'auto'}}>+ Add Worker</button>
        </div>
        {alive.length===0 ? (
          <div className="cockpit-quiet">No live workers in this project.</div>
        ) : (
          <div className="cockpit-swarm-list">
            {alive.map(s => {
              const isBusy = s.status==='busy';
              const elapsed = s.updated_at ? Math.floor((Date.now() - Date.parse(s.updated_at))/1000) : null;
              const elapsedStr = elapsed!=null ? window.SubstrateFmt?.fmtRuntime?.(elapsed)||`${elapsed}s` : '';
              return (
                <div key={s.session_id||s.pid} className={`cockpit-swarm-card ${isBusy?'busy':''}`}>
                  <div className="cockpit-swarm-top">
                    <div className="worker-identity">
                      <div className="worker-avatar">{roleGlyph(s.role)}</div>
                      <span className="cockpit-swarm-name">{s.name || s.session_id.slice(0,8)}</span>
                    </div>
                    <span className={`cockpit-swarm-dot pulse-dot ${isBusy?'running': s.status==='waiting'?'waiting':'idle'}`} style={{marginLeft:'auto'}} />
                    {isBusy && <span className="cockpit-swarm-timer tnum">{elapsedStr}</span>}
                  </div>
                  <div className="cockpit-swarm-meta">
                    <span className="cockpit-swarm-role worker-role">{s.role || 'worker'}</span>
                    {isBusy && <span className="mono" style={{fontSize:10, color:'var(--status-running)'}}>active turn</span>}
                  </div>
                  {s.current_in_progress_ticket && (
                    <div className="cockpit-swarm-task mono" title={s.current_in_progress_ticket.title}>
                      {s.current_in_progress_ticket.display_id||s.current_in_progress_ticket.id}: {s.current_in_progress_ticket.title.slice(0,40)}
                    </div>
                  )}
                  <div className="cockpit-swarm-actions">
                    <button className="orch-btn ghost small" onClick={()=>handlePeek(s)} title="View streaming terminal output">🖥️ Live Output</button>
                    <button className="orch-btn ghost small" onClick={()=>handleSteer(s)} title="Send guidance to agent mid-turn">💬 Send Guidance</button>
                  </div>
                  {/* Progressive disclosure for technical metadata (P1) */}
                  <details className="worker-details">
                    <summary className="worker-details-summary">▸ Details</summary>
                    <div className="worker-details-grid mono">
                      <div><span>Harness:</span> <b>{s.harness || 'pi'}</b></div>
                      <div><span>Model:</span> <b>{s.provider || ''} {s.model || ''}</b></div>
                      <div><span>PID:</span> <b>{s.pid != null ? s.pid : '—'}</b></div>
                      <div><span>Session:</span> <b>{s.session_id?.slice(0,10)}…</b></div>
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="cockpit-right-section cockpit-comments-section">
        <div className="cockpit-right-head">
          <span className="cockpit-right-title">Reviews & Comments</span>
          <span className="cockpit-right-count tnum">{comments.length}</span>
          <span className="cockpit-comment-filter">
            <button className={`cockpit-filter-btn ${filter==='open'?'active':''}`} onClick={()=>setFilter('open')} title="Open feedback">Open</button>
            <button className={`cockpit-filter-btn ${filter==='decision'?'active':''}`} onClick={()=>setFilter('decision')} title="Decisions">Decisions</button>
            <button className={`cockpit-filter-btn ${filter==='resolved'?'active':''}`} onClick={()=>setFilter('resolved')} title="Resolved">Resolved</button>
            <button className={`cockpit-filter-btn ${filter==='all'?'active':''}`} onClick={()=>setFilter('all')} title="All comments">All</button>
          </span>
        </div>

        {/* Decision Summary Box (P1) */}
        {decisionSummary && (
          <div className="cockpit-decision-summary">
            <div className="cockpit-decision-summary-head">
              <span>🔒 Decision Summary</span>
            </div>
            {decisionSummary.map(d => (
              <div key={d.id} className="cockpit-decision-item">
                <span>• {(d.body||'').slice(0, 70)}{(d.body||'').length > 70 ? '…' : ''}</span>
              </div>
            ))}
          </div>
        )}

        {spec ? (
          comments.length===0 ? (
            <div className="cockpit-quiet">No comments in this filter.</div>
          ) : (
            <div className="cockpit-comment-list">
              {comments.slice().sort((a,b)=> (a.created_at||'').localeCompare(b.created_at||'')).map(c => {
                const replyCount = (c.replies||[]).length;
                const isResolved = c.status==='resolved' || c.dispatch_state==='addressed';
                return (
                  <div key={c.id} className={`cockpit-comment ${isResolved?'resolved':''}`}>
                    <div className="cockpit-comment-head">
                      <span className="cockpit-comment-author">{authorMeta(c.author, c.author_label).label}</span>
                      <span className="cockpit-comment-time mono">{fmtAgo(c.created_at||c.updated_at)}</span>
                    </div>
                    <div className="cockpit-comment-body td-body" dangerouslySetInnerHTML={{ __html: renderMd(c.body||'') }} />
                    {c.quote && <div className="cockpit-comment-quote">“{c.quote}”</div>}
                    <div className="cockpit-comment-actions">
                      <button className="orch-btn ghost small" onClick={()=>{
                        const text = prompt('Reply:');
                        if (!text||!text.trim()) return;
                        const pid = spec.display_id||spec.id;
                        window.SubstrateAPI.replyComment(pid, c.id, { author:'human', body:text.trim() }).then(updated=>{
                          if (updated?.parentId || updated?.id) {
                            window.Store.getTicketComments(spec.id);
                          }
                        }).catch(err=> console.error(err));
                      }}>Reply</button>
                      <button className="orch-btn ghost small" onClick={()=>{
                        const dispatchable = window.Store.getState().nativeSessions.filter(s=>s.alive && s.project_id===cid);
                        const target = spec.assignee && dispatchable.some(s=>s.session_id===spec.assignee) ? spec.assignee : dispatchable[0]?.session_id;
                        if (!target) { alert('No live session to dispatch to'); return; }
                        window.SubstrateAPI.dispatchComment(c.id, { session_id: target }).then(res=>{
                          if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
                          if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
                        }).catch(err=> console.error(err));
                      }}>Dispatch</button>
                      {isResolved ? (
                        <span className="cockpit-comment-state mono" style={{color:'var(--status-active)'}}>Resolved ✓</span>
                      ) : c.dispatch_state === 'dispatched' ? (
                        <span className="cockpit-comment-state mono" style={{color:'var(--status-running)'}}>Sent to agent</span>
                      ) : (
                        <span className="cockpit-comment-state mono">Waiting for human</span>
                      )}
                    </div>
                    {c.replies && c.replies.length>0 && (
                      <div className="cockpit-replies">
                        {c.replies.map(r=>(
                          <div key={r.id} className="cockpit-reply">
                            <span className="cockpit-reply-author">{authorMeta(r.author, r.author_label).label}:</span> <span dangerouslySetInnerHTML={{__html: renderMd(r.body)}} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <button className="orch-btn ghost small cockpit-add-comment" onClick={()=>{
                const text = prompt('Add comment:');
                if (!text||!text.trim()) return;
                window.SubstrateAPI.addComment(spec.display_id||spec.id, { author:'human', body:text.trim() }).then(comment=>{
                  // Will be added via WS; also seed optimistically
                }).catch(err=> console.error(err));
              }}>+ Add comment</button>
            </div>
          )
        ) : (
          <div className="cockpit-quiet">Select a spec to see its comments.</div>
        )}
      </div>
    </div>
  );
}

// Keep legacy helpers for compatibility (plan, milestones etc. still exported)
function ProjectPlanSection({ plan, color, ...shell }) { return null; }
function ProjectTrackerBoard({ contractId, ...shell }) { return null; }
function ProjectSpecsBoard({ contractId, ...shell }) { return null; }
function ProjectMilestoneTimeline({ milestones, ...shell }) { return null; }
function ProjectSessions({ sessions, setRoute, ...shell }) { return null; }
function MilestoneStrip({ milestones }) { return null; }

if (typeof PVSection === 'undefined') { window.PVSection = ({children}) => window.React.createElement('div', null, children); } else window.PVSection = PVSection;
if (typeof MilestoneStrip === 'undefined') { window.MilestoneStrip = () => null; } else window.MilestoneStrip = MilestoneStrip;
window.ProjectView = ProjectView;
