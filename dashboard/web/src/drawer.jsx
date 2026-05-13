// Agent drawer — slides in from right on agent click.
// Adapted to read full agent detail (journal+hooks) from the live store; the
// detail is fetched on open via Store.loadAgentDetail() and updated on WS deltas.

function AgentDrawer({ projectId, agentId, open, onClose }) {
  useStore();
  const [tab, setTab] = React.useState('journal');

  React.useEffect(() => { if (open) setTab('journal'); }, [open, agentId]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Refresh detail periodically while drawer is open and the agent is live.
  React.useEffect(() => {
    if (!open || !projectId || !agentId) return;
    const id = setInterval(() => {
      const a = window.Store.getAgent(agentId);
      if (a && (a.status === 'active' || a.status === 'running')) {
        window.Store.loadAgentDetail(projectId, agentId);
      }
    }, 4000);
    return () => clearInterval(id);
  }, [open, projectId, agentId]);

  const summary = agentId ? window.Store.getAgent(agentId) : null;
  const detail = agentId ? window.Store.getAgentDetail(agentId) : null;
  const agent = detail || summary;

  if (!agent) return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
      <aside className={`drawer ${open ? 'open' : ''}`}/>
    </>
  );

  const role = window.Store.getRole(agent.role);
  const project = window.Store.getProject(agent.project);
  const isActive = ['active', 'running', 'review'].includes(agent.status);
  const journal = Array.isArray(agent.journal)
    ? [...agent.journal].sort((a, b) => b.t - a.t)
    : [];
  const hooks = Array.isArray(agent.hooks)
    ? [...agent.hooks].sort((a, b) => b.t - a.t)
    : [];

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
      <aside className={`drawer ${open ? 'open' : ''}`}>
        <div className="drawer-header">
          <div className="drawer-title-row">
            <Avatar role={agent.role} size={36} pulse={isActive}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="drawer-title">{agent.name}</h2>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {role.label} · {project?.name ?? agent.project}
                {agent.team_name && <> · team:{agent.team_name}</>}
              </div>
            </div>
            <StatusPill status={agent.status}/>
            <button className="drawer-close" onClick={onClose}><Icon.Close/></button>
          </div>
          <div className="drawer-meta">
            <div className="drawer-meta-item">
              <Icon.Clock/>
              <span>runtime <strong className="tnum">
                {window.SubstrateFmt.fmtRuntime(
                  agent.started && isActive
                    ? (Date.now() - agent.started) / 1000
                    : agent.runtime
                )}
              </strong></span>
            </div>
            <div className="drawer-meta-item">
              <Icon.Tool/>
              <span>hooks <strong className="tnum">{agent.tools}</strong></span>
            </div>
            <div className="drawer-meta-item" title={agent.session_id}>
              <span>session <strong className="mono">{(agent.session_id || '').slice(0, 12)}</strong></span>
            </div>
          </div>
        </div>

        <div className="drawer-tabs">
          <button className={`drawer-tab ${tab === 'journal' ? 'active' : ''}`} onClick={() => setTab('journal')}>
            Journal <span className="tab-count">{journal.length}</span>
          </button>
          <button className={`drawer-tab ${tab === 'hooks' ? 'active' : ''}`} onClick={() => setTab('hooks')}>
            Hooks <span className="tab-count">{hooks.length}</span>
          </button>
        </div>

        <div className="drawer-body">
          {tab === 'journal' && (
            journal.length === 0 ? (
              <div className="empty">no journal entries</div>
            ) : (
              <div className="journal">
                {journal.map((e, i) => (
                  <div key={`${e.t}-${i}`} className="journal-entry">
                    <div className="journal-time">{window.SubstrateFmt.fmtTimeAgo(e.t)}</div>
                    <div className={`journal-bubble ${e.kind === 'system' ? 'system' : ''}`}>{e.text}</div>
                  </div>
                ))}
              </div>
            )
          )}
          {tab === 'hooks' && (
            hooks.length === 0 ? (
              <div className="empty">no tool calls recorded</div>
            ) : (
              <div className="hooks">
                {hooks.map((h, i) => (
                  <div key={`${h.t}-${i}`} className="hook">
                    <span className="hook-time">{window.SubstrateFmt.fmtTimeAgo(h.t)}</span>
                    <span className="hook-tool">{h.tool}</span>
                    <span className="hook-args" title={h.args || ''}>{h.args}</span>
                    <span className={`hook-status ${h.status}`}>{h.status}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </aside>
    </>
  );
}

window.AgentDrawer = AgentDrawer;
