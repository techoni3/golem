// Root App — routing + global shell.

function App() {
  useStore();
  const [route, setRoute] = React.useState({ kind: 'dashboard' });
  const state = window.Store.getState();

  // Handle deep links via hash.
  React.useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace(/^#/, '');
      if (!h) return;
      const parts = h.split('/').filter(Boolean);
      if (parts[0] === 'project' && parts[1]) {
        setRoute({ kind: 'project', id: parts[1], tab: parts[2] || 'agents' });
      } else if (['dashboard', 'projects', 'agents', 'logs'].includes(parts[0])) {
        setRoute({ kind: parts[0] });
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // Push route → hash.
  React.useEffect(() => {
    let h;
    if (route.kind === 'project') h = `#project/${route.id}/${route.tab || 'agents'}`;
    else h = `#${route.kind}`;
    if (window.location.hash !== h) {
      // Use replaceState to avoid spamming history during drawer open/close.
      history.replaceState(null, '', h);
    }
  }, [route]);

  let page;
  if (!state.ready) {
    page = (
      <div className="page">
        <div className="empty-card">
          <div>connecting…</div>
          <div className="empty-card-hint">
            Loading snapshot from <span className="mono">/api/snapshot</span>.
          </div>
        </div>
      </div>
    );
  } else if (route.kind === 'dashboard') page = <Dashboard setRoute={setRoute}/>;
  else if (route.kind === 'projects') page = <ProjectsPage setRoute={setRoute}/>;
  else if (route.kind === 'agents') page = <AgentsPage setRoute={setRoute}/>;
  else if (route.kind === 'logs') page = <LogsPage/>;
  else if (route.kind === 'project') page = (
    <ProjectView projectId={route.id} tab={route.tab || 'agents'} setRoute={setRoute} openAgentId={route.agentId}/>
  );
  else page = <Dashboard setRoute={setRoute}/>;

  return (
    <div className="app">
      <Sidebar route={route} setRoute={setRoute}/>
      <div className="main">
        <Topbar route={route} setRoute={setRoute}/>
        <OrchestratorRail/>
        {page}
      </div>
      <CeoChatDrawer/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
