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
  const plan = project.plan;

  // Specs for this project
  const allSpecs = window.Store.getTrackerTickets({ project_id: cid, kind: 'spec', includeArchived: true });
  // Sort specs by updated_at desc for tree default ordering
  const specsSorted = window.React.useMemo(() => {
    return [...allSpecs].sort((a,b) => (Date.parse(b.updated_at||b.created_at||'')||0) - (Date.parse(a.updated_at||a.created_at||'')||0));
  }, [allSpecs]);
  const [activeSpecId, setActiveSpecId] = useActiveSpecId(cid, specsSorted);
  const activeSpec = window.React.useMemo(() => {
    if (!activeSpecId) return null;
    return specsSorted.find(s => s.id === activeSpecId || s.display_id === activeSpecId) || specsSorted[0] || null;
  }, [activeSpecId, specsSorted]);

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
            <span style={{ color: 'var(--accent)' }}>{aliveSessions.length} live session{aliveSessions.length === 1 ? '' : 's'}</span>
            {plan && plan.total ? (<><span className="sep">·</span><span>{plan.done}/{plan.total} plan</span></>) : null}
          </div>
        </div>
        <div className="cockpit-hero-actions">
          <button className="orch-btn ghost small" onClick={()=> setDirectiveOpen(true)} title="Send directive (Cmd+K)">+ Send Directive <span className="mono" style={{opacity:.6, marginLeft:6}}>⌘K</span></button>
          <button className="orch-btn small" onClick={()=> setSpawnOpen(true)} title="Spawn worker">+ Spawn Worker</button>
        </div>
      </div>

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
      <div className="cockpit-doc-body td-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="cockpit-subtasks">
        <div className="cockpit-subtasks-head">
          <span className="cockpit-subtasks-title">Sub-tasks</span>
          <span className="cockpit-subtasks-count tnum">{children.length}</span>
          <button className="orch-btn ghost small" onClick={decompose}>+ Task</button>
        </div>
        {children.length===0 ? (
          <div className="cockpit-quiet">No sub-tasks yet. Decompose this spec to create work items.</div>
        ) : (
          <div className="cockpit-task-table">
            <div className="cockpit-task-header">
              <span>Kind</span><span>ID</span><span>Title</span><span>Assignee</span><span>Branch</span><span>State</span>
            </div>
            {children.map(t => (
              <div key={t.id} className="cockpit-task-row">
                <span className="cockpit-task-kind">{t.kind==='spec'? '📄' : t.kind==='doc'? '📝' : '◻️'}</span>
                <a className="mono cockpit-task-id" href={window.Router.buildHref({kind:'ticket', id:t.id})} onClick={(e)=>{e.preventDefault(); window.Router.openTicket(t.id);}}>{t.display_id||t.id}</a>
                <span className="cockpit-task-title" title={t.title}>{t.title}</span>
                <span className="cockpit-task-assignee">{t.assignee_label || labelBySession.get(t.assignee) || (t.assignee? t.assignee.slice(0,8): '—')}</span>
                <span className="cockpit-task-branch mono">{t.branch || t.worktree || '—'}</span>
                <button className={`pill cockpit-task-state ${statePillClass(t.state)}`} onClick={()=>handleTaskState(t)} title="Cycle state: todo → in_progress → review → done">{t.state}</button>
              </div>
            ))}
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
  const [filter, setFilter] = window.React.useState('open'); // open | all
  const alive = window.Store.getProjectAliveSessions(project);
  const spec = activeSpec ? (window.Store.getState().trackerTickets.get(activeSpec.id) || activeSpec) : null;
  const allComments = spec ? (window.Store.getTicketComments(spec.id) || []) : [];
  const comments = window.React.useMemo(() => {
    if (filter==='all') return allComments;
    return allComments.filter(c => c.status==='open');
  }, [allComments, filter]);

  // Tick for pulsing timer (re-render every 2s to update elapsed)
  const [, tick] = window.React.useState(0);
  window.React.useEffect(()=>{ const id=setInterval(()=>tick(n=>n+1),2000); return ()=>clearInterval(id); },[]);

  const handlePeek = (session) => {
    if (session.session_id && onPeek) { onPeek(session.session_id); return; }
    if (session.session_id) window.Router.openNativeSession(session.session_id);
  };
  const handleSteer = (session) => {
    const msg = prompt(`Steer message for ${session.name||session.session_id.slice(0,8)}:`);
    if (!msg || !msg.trim()) return;
    window.SubstrateAPI.pushBrief(msg.trim(), session.session_id).catch(err=> console.error(err));
  };

  return (
    <div className="cockpit-right">
      <div className="cockpit-right-section">
        <div className="cockpit-right-head">
          <span className="cockpit-right-title">Swarm</span>
          <span className="cockpit-right-count tnum">{alive.length}</span>
          <button className="orch-btn ghost small" onClick={()=> onSpawn && onSpawn()} title="Spawn worker" style={{marginLeft:'auto'}}> + Spawn</button>
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
                    <span className="cockpit-swarm-name">{s.name || s.session_id.slice(0,8)}</span>
                    <span className={`cockpit-swarm-dot ${isBusy?'busy': s.status==='waiting'?'waiting':'idle'}`} />
                    {isBusy && <span className="cockpit-swarm-timer tnum">{elapsedStr}</span>}
                  </div>
                  <div className="cockpit-swarm-meta">
                    <span className="cockpit-swarm-role">{s.role || '—'}</span>
                    <span className="cockpit-swarm-model mono">{s.provider||''} {s.model||''}</span>
                  </div>
                  {s.current_in_progress_ticket && (
                    <div className="cockpit-swarm-task mono" title={s.current_in_progress_ticket.title}>
                      {s.current_in_progress_ticket.display_id||s.current_in_progress_ticket.id}: {s.current_in_progress_ticket.title.slice(0,40)}
                    </div>
                  )}
                  <div className="cockpit-swarm-actions">
                    <button className="orch-btn ghost small" onClick={()=>handlePeek(s)}>🖥️ Peek</button>
                    <button className="orch-btn ghost small" onClick={()=>handleSteer(s)}>💬 Steer</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="cockpit-right-section cockpit-comments-section">
        <div className="cockpit-right-head">
          <span className="cockpit-right-title">Spec Comments</span>
          <span className="cockpit-right-count tnum">{comments.length}</span>
          <span className="cockpit-comment-filter">
            <button className={`cockpit-filter-btn ${filter==='open'?'active':''}`} onClick={()=>setFilter('open')}>Open</button>
            <button className={`cockpit-filter-btn ${filter==='all'?'active':''}`} onClick={()=>setFilter('all')}>All</button>
          </span>
        </div>
        {spec ? (
          comments.length===0 ? (
            <div className="cockpit-quiet">No comments on this spec.</div>
          ) : (
            <div className="cockpit-comment-list">
              {comments.slice().sort((a,b)=> (a.created_at||'').localeCompare(b.created_at||'')).map(c => {
                const replyCount = (c.replies||[]).length;
                return (
                  <div key={c.id} className={`cockpit-comment ${c.status==='resolved'?'resolved':''}`}>
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
                            // Seed via store will be handled by WS, but optimistic update:
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
                      {c.dispatch_state && <span className="cockpit-comment-state mono">{c.dispatch_state}</span>}
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
