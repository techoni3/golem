// Root App — routing + global shell.

function App() {
  useStore();
  // Route state is driven by window.Router (path-based). The router pushes
  // history on navigation (so Back traverses pages) and dispatches `route-change`
  // on every change; popstate fires on Back/Forward. Both keep this state in
  // sync with the URL. Replaces the old hash+replaceState model that never
  // pushed, so Back used to exit the SPA.
  const [route, setRoute] = React.useState(() => window.Router.parseLocation());
  const state = window.Store.getState();

  React.useEffect(() => {
    const sync = () => setRoute(window.Router.parseLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener('route-change', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('route-change', sync);
    };
  }, []);

  // setRoute navigates (push) — real links + in-app nav both go through this.
  // Callers that want replace semantics (filter typing) call window.Router.go
  // directly with {replace:true}.
  const navigate = (r) => window.Router.go(r);

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
  } else if (route.kind === 'dashboard') page = <Dashboard setRoute={navigate}/>;
  else if (route.kind === 'tracker') page = <TrackerBoard setRoute={navigate}/>;
  else if (route.kind === 'projects') page = <ProjectsPage setRoute={navigate}/>;
  else if (route.kind === 'agents') page = <AgentsPage setRoute={navigate}/>;
  else if (route.kind === 'logs') page = <LogsPage/>;
  else if (route.kind === 'project') page = (
    <ProjectView projectId={route.id} tab={route.tab} showArchived={route.showArchived} q={route.q} setRoute={navigate}/>
  );
  else page = <Dashboard setRoute={navigate}/>;

  return (
    <div className="app">
      <Sidebar route={route} setRoute={navigate}/>
      <div className="main">
        <Topbar route={route} setRoute={navigate}/>
        <OrchestratorRail/>
        {page}
      </div>
      <CeoChatDrawer/>
      <NativeSessionDrawer/>
      <CreateTicketDrawer/>
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
