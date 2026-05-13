// Project view — Agents timeline + Tracker kanban. Adapted to live store.

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

  const openAgent = (id) => {
    setDrawerAgentId(id);
    setDrawerOpen(true);
    // Eager-load full detail so journal+hooks appear quickly.
    window.Store.loadAgentDetail(projectId, id);
  };
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <>
      <div className="page">
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
          <div style={{ flex: 1 }}>
            <h1 className="project-hero-name">{project.name}</h1>
            <div className="project-hero-meta">
              <span>substrate/{project.id}</span>
              <span className="sep">·</span>
              <span>{project.total_tickets} tickets</span>
              <span className="sep">·</span>
              <span>{Math.round((project.progress || 0) * 100)}% done</span>
              <span className="sep">·</span>
              <span style={{ color: 'var(--accent)' }}>{liveAgents.length} live agents</span>
            </div>
          </div>
        </div>

        <div className="tabs">
          <button
            className={`tab ${tab === 'agents' ? 'active' : ''}`}
            onClick={() => setRoute({ kind: 'project', id: projectId, tab: 'agents' })}
          >
            Agents <span className="tab-count">{agents.length}</span>
          </button>
          <button
            className={`tab ${tab === 'tracker' ? 'active' : ''}`}
            onClick={() => setRoute({ kind: 'project', id: projectId, tab: 'tracker' })}
          >
            Tracker <span className="tab-count">{tickets.length}</span>
          </button>
        </div>

        {tab === 'agents' && (
          <AgentsTimeline
            agents={agents}
            onOpen={openAgent}
            activeId={drawerOpen ? drawerAgentId : null}
            project={project}
          />
        )}
        {tab === 'tracker' && <Kanban tickets={tickets} agents={agents}/>}
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

  // Diff against previous render to flag tickets that just appeared or moved
  // columns. The CSS in styles.css animates `.ticket.entering` for ~480ms.
  const prevPosRef = React.useRef(new Map()); // ticketId → column
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
    // Skip the very first render — every ticket would flash.
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
window.AgentsTimeline = AgentsTimeline;
window.Kanban = Kanban;
