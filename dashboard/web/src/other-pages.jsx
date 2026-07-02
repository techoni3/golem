// Agents / Projects / Logs pages. All read live store.

function AgentsPage({ setRoute }) {
  useStore();
  const all = window.Store.getNativeSessions();

  // v4: the server already pid-checks native sessions and marks them .alive.
  // Drop anything not alive so dead registry rows / stale CLI entries never
  // render on the Agents page.
  const alive = all.filter((s) => s.alive);

  // TKT-0286: all pending dispatch-queue rows (enriched with ticket_title +
  // session_label by listDispatchQueue). Refetch on the dispatch-queue-updated
  // WS signal (rev) — no polling. Grouped by session for the card chip; rows
  // whose target session is no longer alive surface as offline orphans.
  const dispatchQueueRev = window.Store.getState().dispatchQueueRev || 0;
  const [queue, setQueue] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    window.SubstrateAPI.getJSON('/api/dispatch-queue')
      .then((rows) => { if (!cancelled) setQueue(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setQueue([]); });
    return () => { cancelled = true; };
  }, [dispatchQueueRev]);
  const queueBySession = React.useMemo(() => {
    const m = new Map();
    for (const r of queue) {
      const arr = m.get(r.session_id) ?? [];
      arr.push(r);
      m.set(r.session_id, arr);
    }
    return m;
  }, [queue]);
  const aliveIds = new Set(alive.map((s) => s.session_id));
  const orphans = queue.filter((r) => !aliveIds.has(r.session_id));

  // Disambiguate duplicate session names by appending project name + short sid.
  const nameCounts = {};
  for (const s of alive) {
    const key = s.name || '';
    nameCounts[key] = (nameCounts[key] || 0) + 1;
  }
  const formatName = (s) => {
    const base = s.name || s.session_id?.slice(0, 8) || `pid ${s.pid}`;
    if ((nameCounts[s.name || ''] || 0) <= 1) return base;
    const project = window.Store.getProjectByContractId(s.project_id);
    const suffix = project?.name || s.project_id || s.session_id?.slice(0, 8) || String(s.pid);
    return `${base} · ${suffix}`;
  };

  const isWorking = (s) => s.status === 'busy' || s.status === 'waiting';
  const byRecency = (a, b) => (b.updated_at ?? b.started_at ?? 0) - (a.updated_at ?? a.started_at ?? 0);
  const working = alive.filter(isWorking).sort(byRecency);
  const idle = alive.filter((s) => !isWorking(s)).sort(byRecency);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <div className="page-subtitle">{alive.length} native Claude Code session{alive.length === 1 ? '' : 's'} online.</div>
        </div>
      </div>

      {alive.length === 0 && orphans.length === 0 ? (
        <EmptyCard
          label="no native sessions online"
          hint={<>Start a <span className="mono">claude</span> session to bring agents online.</>}
        />
      ) : (
        <>
          {working.length > 0 && (
            <div className="agents-section">
              <div className="agents-section-head">
                <Icon.Gear size={16} className="gear gear-working"/>
                <span className="agents-section-title">Working</span>
                <span className="agents-section-count">{working.length}</span>
              </div>
              <div className="native-sessions">
                {working.map((s) => (
                  <SessionCard key={s.session_id || s.pid} session={s} name={formatName(s)} queueCount={queueBySession.get(s.session_id)?.length || 0}/>
                ))}
              </div>
            </div>
          )}

          {idle.length > 0 && (
            <div className="agents-section">
              <div className="agents-section-head">
                <Icon.Gear size={16} className="gear gear-idle"/>
                <span className="agents-section-title">Idle</span>
                <span className="agents-section-count">{idle.length}</span>
              </div>
              <div className="native-sessions">
                {idle.map((s) => (
                  <SessionCard key={s.session_id || s.pid} session={s} name={formatName(s)} queueCount={queueBySession.get(s.session_id)?.length || 0}/>
                ))}
              </div>
            </div>
          )}

          {orphans.length > 0 && (
            <OfflineOrphansSection rows={orphans}/>
          )}
        </>
      )}
    </div>
  );
}

function SessionCard({ session, name, queueCount = 0 }) {
  const working = session.status === 'busy' || session.status === 'waiting';
  const registered = session.registered || !!window.Store.getProjectByContractId(session.project_id);
  const openPeek = () => {
    if (session.session_id) window.openNativeSessionDrawer(session.session_id);
  };
  return (
    <div
      className={`native-session-card ${working ? 'busy' : 'idle'} cc-clickable`}
      onClick={openPeek}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeek(); } }}
      title="open session details"
    >
      <div className="native-session-top">
        <Icon.Gear size={16} className={`gear gear-${working ? 'working' : 'idle'}`}/>
        <span className="native-session-name">{name}</span>
        {queueCount > 0 && (
          <span className="native-session-queue-chip" title={`${queueCount} dispatch${queueCount === 1 ? '' : 'es'} queued — delivers when this session is idle`}>⏳ {queueCount} queued</span>
        )}
        <span className={`native-session-status status-${working ? 'busy' : 'idle'}`}>
          {session.status || 'idle'}
          {session.waiting_for ? ` · ${session.waiting_for}` : ''}
        </span>
        {!registered && (
          <span className="native-session-badge" title="this project is not registered with the dashboard">
            unregistered
          </span>
        )}
      </div>
      <div className="native-session-cwd mono" title={session.cwd || ''}>
        {session.cwd || '—'}
      </div>
      <div className="native-session-meta">
        <span className="mono">pid {session.pid ?? '?'}</span>
        {session.session_id && <span className="mono" title={session.session_id}>{session.session_id.slice(0, 8)}</span>}
        {session.project_id && <span className="mono" title="derived project_id">{session.project_id}</span>}
        {session.updated_at && (
          <span title="last updated">
            {window.SubstrateFmt?.fmtClock?.(session.updated_at) || ''}
          </span>
        )}
      </div>
    </div>
  );
}

function ProjectCard({ p, setRoute }) {
  const live = window.Store.getProjectAliveSessions(p).length;
  return (
    <div
      key={p.id}
      className={`project-card ${p.stale ? 'project-card-stale' : ''}`}
      onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
    >
      <div className="project-card-top">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ProjectGlyph project={p}/>
          <div>
            <div className="project-card-name">{p.name}</div>
            <div className="project-card-id mono">{p.id}</div>
          </div>
        </div>
        {live > 0
          ? <span className="pill active"><span className="dot"/>Active</span>
          : <span className="pill idle"><span className="dot"/>Idle</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden' }}>
        {p.description || <span style={{ color: 'var(--text-4)' }}>no description</span>}
      </div>
      <div className="project-card-stats">
        <div className="project-stat">
          <div className="project-stat-value tnum">{live}</div>
          <div className="project-stat-label">live sessions</div>
        </div>
        <div className="project-stat" style={{ marginLeft: 'auto' }}>
          <div className="project-stat-value tnum" style={{ color: p.color }}>
            {Math.round((p.progress || 0) * 100)}%
          </div>
          <div className="project-stat-label">{p.total_tickets} tickets</div>
        </div>
      </div>
      <div className="project-card-progress">
        <div className="project-card-progress-fill"
          style={{ width: `${(p.progress || 0) * 100}%`, background: p.color }}/>
      </div>
      {p.plan && p.plan.total > 0 && (
        <PlanProgress plan={p.plan} color={p.color}/>
      )}
    </div>
  );
}

function ProjectsPage({ setRoute }) {
  useStore();
  const [includeStale, setIncludeStale] = React.useState(false);
  const projects = window.Store.getState().projects;
  const active = projects.filter((p) => !p.stale);
  const stale = projects.filter((p) => p.stale);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <div className="page-subtitle">{active.length} active · {stale.length} stale</div>
        </div>
        <label className="tracker-toggle stale-toggle">
          <input
            type="checkbox"
            checked={includeStale}
            onChange={(e) => setIncludeStale(e.target.checked)}
          />
          Include stale
        </label>
      </div>
      {projects.length === 0 ? (
        <EmptyCard
          label="no projects discovered"
          hint={<>Bootstrap a project under <span className="mono">~/Documents/software/experiments/golem/golem-projects/</span> — the harness will scaffold and register it in-session.</>}
        />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {active.map(p => <ProjectCard key={p.id} p={p} setRoute={setRoute}/>)}
          </div>
          {includeStale && stale.length > 0 && (
            <div className="stale-section">
              <div className="stale-section-head">
                <Icon.Archive size={16}/>
                <span className="stale-section-title">Stale</span>
                <span className="stale-section-count">{stale.length}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                {stale.map(p => <ProjectCard key={p.id} p={p} setRoute={setRoute}/>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LogsPage() {
  useStore();
  const milestones = window.Store.getRecentMilestones();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity</h1>
          <div className="page-subtitle">Cross-project milestone feed from native Claude Code sessions.</div>
        </div>
        <div className="topbar-meta">
          <ConnectionPill status={window.Store.getState().connection}/>
        </div>
      </div>
      {milestones.length === 0 ? (
        <EmptyCard
          label="no recent activity"
          hint={<>Sessions append milestones as work lands — they appear here and on the command center home.</>}
        />
      ) : (
        <ul className="cc-feed">
          {milestones.map((m, i) => {
            const project = window.Store.getProjectByContractId(m.project);
            return (
              <li key={`${m.t}-${i}`} className="cc-feed-item">
                <span className="cc-feed-dot" style={{ background: m.project_color || 'var(--accent)' }}/>
                <div className="cc-feed-body">
                  <div className="cc-feed-text">{m.text}</div>
                  <div className="cc-feed-meta">
                    <ProjectChip project={project} projectId={m.project} registered/>
                    <span className="cc-feed-ts mono">{window.SubstrateFmt.fmtTimeAgo(m.t)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// TKT-0286: pending dispatches whose target session is no longer alive. Named
// via the persisted session_labels join (the live-session list can't resolve
// them). Rendered below Working/Idle on the Agents page; Cancel relies on the
// dispatch-queue-updated WS signal for refresh (no manual refetch, no polling).
function OfflineOrphansSection({ rows }) {
  const [errors, setErrors] = React.useState({});
  const cancel = (qid) => {
    window.SubstrateAPI.delJSON(`/api/dispatch-queue/${encodeURIComponent(qid)}`)
      .catch((err) => setErrors((e) => ({ ...e, [qid]: String(err?.message || err) })));
  };
  const sessionLabel = (r) => r.session_label || `session ${String(r.session_id || '').slice(0, 8)}`;
  const ago = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? (window.SubstrateFmt?.fmtTimeAgo?.(t) || '') : ''; };
  return (
    <div className="agents-section agents-section-orphans">
      <div className="agents-section-head">
        <Icon.Archive size={16}/>
        <span className="agents-section-title">Queued for offline sessions</span>
        <span className="agents-section-count">{rows.length}</span>
      </div>
      <div className="native-sessions">
        {rows.map((r) => (
          <div key={r.id} className="orphan-row">
            <div className="orphan-row-top">
              <span className="orphan-session-label" title={r.session_id}>{sessionLabel(r)}</span>
              <a className="orphan-ticket-link"
                href={window.Router.buildHref({ kind: 'ticket', id: r.ticket_id })}
                onClick={(e) => { e.preventDefault(); window.Router.openTicket(r.ticket_id); }}
                title={r.ticket_title || r.ticket_id}
              >
                <span className="mono">{r.ticket_id}</span>
                {r.ticket_title ? <span className="orphan-ticket-title">{r.ticket_title}</span> : null}
              </a>
              <span className="orphan-ago" title={r.created_at}>{ago(r.created_at)}</span>
              <button className="orch-btn small ghost orphan-cancel" onClick={() => cancel(r.id)} title="Cancel this queued dispatch">Cancel</button>
            </div>
            <div className="orphan-row-hint">expires after 60m offline</div>
            {errors[r.id] && <div className="orphan-row-err">{errors[r.id]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

window.AgentsPage = AgentsPage;
window.ProjectsPage = ProjectsPage;
window.LogsPage = LogsPage;
