// Agents / Projects / Logs pages. All read live store.

function AgentsPage({ setRoute }) {
  useStore();
  const all = window.Store.getAllAgents().slice().sort((a, b) => {
    const order = { active: 0, running: 1, review: 2, blocked: 3, done: 4 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <div className="page-subtitle">All agents across the harness, sorted by liveness.</div>
        </div>
      </div>
      {all.length === 0 ? (
        <EmptyCard
          label="no agents recorded"
          hint={<>Start a <span className="mono">/golem</span> session in any project to populate this view.</>}
        />
      ) : (
        <div className="agents-grid">
          {all.map(a => {
            const role = window.Store.getRole(a.role);
            const project = window.Store.getProject(a.project);
            const isLive = ['active', 'running', 'review'].includes(a.status);
            const runtime = a.started && isLive ? (Date.now() - a.started) / 1000 : a.runtime;
            return (
              <div
                key={a.id}
                className="agent-card"
                onClick={() => setRoute({ kind: 'project', id: a.project, tab: 'agents', agentId: a.id })}
              >
                <Avatar role={a.role} size={36} pulse={a.status === 'running'}/>
                <div className="agent-card-body">
                  <div className="agent-card-row1">
                    <div>
                      <div className="agent-card-name">{a.name}</div>
                      <div className="agent-card-role">
                        {role.label} · {project?.name ?? a.project}
                      </div>
                    </div>
                    <StatusPill status={a.status}/>
                  </div>
                  <div className="agent-card-action" title={a.action || ''}>
                    {a.action || <span style={{ color: 'var(--text-4)' }}>—</span>}
                  </div>
                  <div className="agent-card-meta">
                    <span className="agent-card-meta-item"><Icon.Clock/>{window.SubstrateFmt.fmtRuntime(runtime)}</span>
                    <span className="agent-card-meta-item"><Icon.Tool/>{a.tools} hooks</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectsPage({ setRoute }) {
  useStore();
  const projects = window.Store.getState().projects;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <div className="page-subtitle">{projects.length} projects under the harness.</div>
        </div>
      </div>
      {projects.length === 0 ? (
        <EmptyCard
          label="no projects discovered"
          hint={<>Ask the CEO to bootstrap one under <span className="mono">~/Documents/software/experiments/golem/golem-projects/</span> — the Substrator agent will scaffold it in-session.</>}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {projects.map(p => {
            const live = window.Store.getProjectActiveAgents(p.id).length;
            const all = window.Store.getProjectAgents(p.id).length;
            return (
              <div
                key={p.id}
                className="project-card"
                onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
              >
                <div className="project-card-top">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <ProjectGlyph project={p}/>
                    <div>
                      <div className="project-card-name">{p.name}</div>
                      <div className="project-card-id mono">substrate/{p.id}</div>
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
                    <div className="project-stat-label">live</div>
                  </div>
                  <div className="project-stat">
                    <div className="project-stat-value tnum">{all}</div>
                    <div className="project-stat-label">total</div>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogsPage() {
  useStore();
  const ref = React.useRef(null);
  const [recent, setRecent] = React.useState([]);

  // Poll all live agents' detail to gather rolling log lines. Cheap because
  // detail responses are bounded by hook/journal caps server-side.
  React.useEffect(() => {
    let cancelled = false;
    async function tick() {
      const agents = window.Store.getActiveAgents();
      const events = [];
      // Limit fan-out to ~8 most recent agents to keep log fetches modest.
      const sample = agents.slice(0, 8);
      const details = await Promise.all(
        sample.map((a) =>
          window.Store
            .loadAgentDetail(a.project, a.id)
            .catch(() => null)
            .then((d) => d || window.Store.getAgentDetail(a.id))
        )
      );
      // Also pull cached details for any agent we already loaded.
      for (const a of window.Store.getAllAgents()) {
        const d = window.Store.getAgentDetail(a.id);
        if (d) detail2events(d, events);
      }
      detailsToEvents(details.filter(Boolean), events);
      events.sort((a, b) => a.t - b.t);
      if (!cancelled) setRecent(events.slice(-300));
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Journals & Logs</h1>
          <div className="page-subtitle">Combined event stream across active agents · auto-scrolling.</div>
        </div>
        <div className="topbar-meta">
          <ConnectionPill status={window.Store.getState().connection}/>
        </div>
      </div>
      {recent.length === 0 ? (
        <EmptyCard
          label="no recent events"
          hint={<>The combined log fills as agents fire hooks and append journal entries.</>}
        />
      ) : (
        <div className="log-stream" ref={ref}>
          {recent.map((e, i) => (
            <div key={i} className="log-line">
              <span className="log-time">{window.SubstrateFmt.fmtClock(e.t)}</span>
              <span className={`log-level ${e.kind === 'hook' ? (e.status === 'err' ? 'err' : 'ok') : 'info'}`}>
                {e.kind === 'hook' ? e.status : 'msg'}
              </span>
              <span className="log-source">{e.agent}</span>
              <span>
                {e.kind === 'hook'
                  ? <><span style={{ color: 'var(--accent)' }}>{e.tool}</span> <span style={{ color: 'var(--text-2)' }}>{e.args}</span></>
                  : <span style={{ color: 'var(--text-1)' }}>{e.text}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function detail2events(d, out) {
  // Flatten an agent detail's recent journal+hooks into the log feed.
  if (!d) return;
  const recentJournal = (d.journal || []).slice(-12);
  for (const j of recentJournal) {
    out.push({ t: j.t, kind: 'journal', agent: d.name, text: j.text });
  }
  const recentHooks = (d.hooks || []).slice(-12);
  for (const h of recentHooks) {
    out.push({ t: h.t, kind: 'hook', agent: d.name, tool: h.tool, args: h.args, status: h.status });
  }
}

function detailsToEvents(details, out) {
  for (const d of details) detail2events(d, out);
}

window.AgentsPage = AgentsPage;
window.ProjectsPage = ProjectsPage;
window.LogsPage = LogsPage;
