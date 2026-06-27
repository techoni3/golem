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
        setRoute({ kind: 'project', id: parts[1] });
      } else if (['dashboard', 'tracker', 'projects', 'agents', 'logs'].includes(parts[0])) {
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
    if (route.kind === 'project') h = `#project/${route.id}`;
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
  else if (route.kind === 'tracker') page = <TrackerBoard setRoute={setRoute}/>;
  else if (route.kind === 'projects') page = <ProjectsPage setRoute={setRoute}/>;
  else if (route.kind === 'agents') page = <AgentsPage setRoute={setRoute}/>;
  else if (route.kind === 'logs') page = <LogsPage/>;
  else if (route.kind === 'project') page = (
    <ProjectView projectId={route.id} setRoute={setRoute}/>
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
      <NativeSessionDrawer/>
      <CreateTicket/>
      <TicketDrawer/>
    </div>
  );
}

// TKT-0103: defer the mount until window.__reactReady is set by the ESM
// block in index.html. The ESM block also performs a mount via
// ReactDOMClient.createRoot, so this becomes a no-op if it ran first. The
// guard handles the case where babel-standalone processes this file before
// the ESM block has finished (race) — without the guard, line below would
// throw "Cannot read properties of undefined (reading 'createRoot')".
function mount() {
  if (!window.ReactDOM || !window.ReactDOMClient) {
    return setTimeout(mount, 30);
  }
  const root = window.ReactDOMClient.createRoot(document.getElementById('root'));
  root.render(window.React.createElement(App));
}
mount();
