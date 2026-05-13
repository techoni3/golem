// Dashboard page — adapted to live store. Two summary cards + project &
// active-agent carousels.

function Dashboard({ setRoute }) {
  useStore();
  const projectsRef = React.useRef(null);
  const agentsRef = React.useRef(null);

  const state = window.Store.getState();
  const allAgents = window.Store.getAllAgents();
  const activeAgents = window.Store.getActiveAgents();
  const projects = state.projects;

  const counts = {
    active: allAgents.filter(a => a.status === 'active').length,
    running: allAgents.filter(a => a.status === 'running').length,
    review: allAgents.filter(a => a.status === 'review').length,
    done: allAgents.filter(a => a.status === 'done').length,
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-subtitle">Real-time overview of the harness substrate.</div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-card-header">
            <div className="summary-card-label">Active Agents</div>
            <ConnectionPill status={state.connection}/>
          </div>
          <div className="summary-card-value tnum">
            {String(activeAgents.length).padStart(2, '0')}
            <span className="summary-card-value-suffix">/ {allAgents.length} total</span>
          </div>
          <div className="summary-card-meta">
            <span><strong>{counts.active}</strong> executing</span>
            <span><strong>{counts.running}</strong> in tool call</span>
            <span><strong>{counts.review}</strong> reviewing</span>
            <span><strong>{counts.done}</strong> done</span>
          </div>
          <div className="summary-card-spark" style={{ color: 'var(--accent)' }}>
            <Icon.Spark size={80}/>
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-card-header">
            <div className="summary-card-label">Projects in Development</div>
            <span className="pill"><span className="dot"/>{projects.length} discovered</span>
          </div>
          <div className="summary-card-value tnum">
            {String(projects.length).padStart(2, '0')}
            <span className="summary-card-value-suffix">under harness</span>
          </div>
          <div className="summary-card-meta">
            {projects.length === 0 && <span style={{ fontStyle: 'italic' }}>none discovered yet</span>}
            {projects.map(p => (
              <span key={p.id}>
                <strong style={{ color: p.color }}>●</strong> {p.name}
              </span>
            ))}
          </div>
          <div className="summary-card-spark" style={{ color: 'var(--text-3)' }}>
            <Icon.Spark size={80}/>
          </div>
        </div>
      </div>

      {/* Projects carousel */}
      <div className="row-section">
        <div className="row-header">
          <div className="row-title">
            Projects
            <span className="row-title-count">{projects.length}</span>
          </div>
          <CarouselControls trackRef={projectsRef}/>
        </div>
        {projects.length === 0 ? (
          <EmptyCard
            label="no projects discovered"
            hint={
              <>
                Ask the CEO to bootstrap one under
                <span className="mono"> ~/Documents/software/experiments/golem/golem-projects/</span>
                — the Substrator agent will scaffold it in-session.
              </>
            }
          />
        ) : (
          <div className="carousel">
            <div className="carousel-track" ref={projectsRef}>
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
                        <div className="project-stat-label">live agents</div>
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
          </div>
        )}
      </div>

      {/* Agents carousel */}
      <div className="row-section">
        <div className="row-header">
          <div className="row-title">
            Active Agents
            <span className="row-title-count">{activeAgents.length}</span>
          </div>
          <CarouselControls trackRef={agentsRef}/>
        </div>
        {activeAgents.length === 0 ? (
          <EmptyCard
            label="no active agents"
            hint={
              <>
                Agents appear here when sessions are live. Run <span className="mono">/golem</span> in a project to bring them online.
              </>
            }
          />
        ) : (
          <div className="carousel">
            <div className="carousel-track" ref={agentsRef}>
              {activeAgents.map(a => {
                const role = window.Store.getRole(a.role);
                const project = window.Store.getProject(a.project);
                return (
                  <div
                    key={a.id}
                    className="agent-card"
                    onClick={() => setRoute({ kind: 'project', id: a.project, tab: 'agents', agentId: a.id })}
                  >
                    <Avatar role={a.role} size={36} pulse={a.status === 'running' || a.status === 'active'}/>
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
                        {a.action || <span style={{ color: 'var(--text-4)' }}>idle</span>}
                      </div>
                      <div className="agent-card-meta">
                        <span className="agent-card-meta-item"><Icon.Clock/>
                          {window.SubstrateFmt.fmtRuntime(
                            a.started ? (Date.now() - a.started) / 1000 : a.runtime
                          )}
                        </span>
                        <span className="agent-card-meta-item"><Icon.Tool/>{a.tools} hooks</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyCard({ label, hint }) {
  return (
    <div className="empty-card">
      <div>{label}</div>
      <div className="empty-card-hint">{hint}</div>
    </div>
  );
}

window.Dashboard = Dashboard;
window.EmptyCard = EmptyCard;
