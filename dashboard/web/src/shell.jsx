// Sidebar + Topbar shell — adapted to use window.Store instead of SubstrateData.

function Sidebar({ route, setRoute }) {
  useStore();
  const projects = window.Store.getState().projects;
  const activeCount = window.Store.getActiveAgents().length;
  const projectCount = projects.length;

  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: Icon.Dashboard },
    { id: 'projects', label: 'Projects', icon: Icon.Projects, count: projectCount },
    { id: 'agents', label: 'Agents', icon: Icon.Agents, count: activeCount },
    { id: 'logs', label: 'Journals & Logs', icon: Icon.Logs },
  ];

  const isActive = (id) => {
    if (route.kind === 'project') return id === 'projects';
    return route.kind === id;
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">G</div>
        <div>
          <div className="sidebar-brand-text">Golem</div>
          <div className="sidebar-brand-sub">substrate · admin</div>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Workspace</div>
        <nav className="sidebar-nav">
          {items.map(item => {
            const I = item.icon;
            return (
              <button
                key={item.id}
                className={`sidebar-link ${isActive(item.id) ? 'active' : ''}`}
                onClick={() => setRoute({ kind: item.id })}
              >
                <span className="sidebar-link-icon"><I /></span>
                <span>{item.label}</span>
                {item.count != null && <span className="sidebar-link-count">{item.count}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Projects</div>
        <nav className="sidebar-nav">
          {projects.length === 0 && (
            <div style={{ padding: '8px 8px 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              no projects discovered
            </div>
          )}
          {projects.map(p => {
            const active = route.kind === 'project' && route.id === p.id;
            const live = window.Store.getProjectActiveAgents(p.id).length;
            return (
              <button
                key={p.id}
                className={`sidebar-link ${active ? 'active' : ''}`}
                onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
              >
                <span className="sidebar-link-icon" style={{ color: p.color }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block',
                    boxShadow: live ? `0 0 6px ${p.color}` : 'none'
                  }}/>
                </span>
                <span>{p.name}</span>
                <span className="sidebar-link-count">{live}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-footer-dot"/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>HARNESS · {window.Store.getState().connection === 'connected' ? 'ONLINE' : 'OFFLINE'}</div>
          <div style={{ color: 'var(--text-3)', marginTop: 2 }}>v0.1.0</div>
        </div>
        <TweaksButton/>
      </div>
    </aside>
  );
}

function Topbar({ route, setRoute }) {
  useStore();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const crumbs = [];
  crumbs.push({ label: 'Substrate', onClick: () => setRoute({ kind: 'dashboard' }) });
  if (route.kind === 'dashboard') crumbs.push({ label: 'Dashboard', current: true });
  if (route.kind === 'projects') crumbs.push({ label: 'Projects', current: true });
  if (route.kind === 'agents') crumbs.push({ label: 'Agents', current: true });
  if (route.kind === 'logs') crumbs.push({ label: 'Journals & Logs', current: true });
  if (route.kind === 'project') {
    crumbs.push({ label: 'Projects', onClick: () => setRoute({ kind: 'projects' }) });
    const p = window.Store.getProject(route.id);
    crumbs.push({ label: p?.name || route.id, current: true });
  }

  const live = window.Store.getActiveAgents().length;
  const connection = window.Store.getState().connection;

  return (
    <header className="topbar">
      <div className="crumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {c.current
              ? <span className="crumb-current">{c.label}</span>
              : <span className="crumb-link" onClick={c.onClick}>{c.label}</span>}
          </React.Fragment>
        ))}
      </div>
      <div className="topbar-spacer"/>
      <div className="topbar-meta">
        <ConnectionPill status={connection}/>
        <span className="topbar-meta-item">
          <Icon.Activity/> {live} agents live
        </span>
        <span className="topbar-meta-item">
          <Icon.Clock/> {window.SubstrateFmt.fmtClock(now)}
        </span>
      </div>
    </header>
  );
}

window.Sidebar = Sidebar;
window.Topbar = Topbar;
