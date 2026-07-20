// Root App — routing + global shell.

// The typed dashboard shell imports these two leaf seams independently.  The
// compatibility island never mounts this App: it owns the URL/history and
// supplies the selected route plus one close callback.  Keeping the page and
// drawer exports here preserves the current product components without giving
// them a second shell, router listener, or overlay owner.
export function LegacyDashboardPageBody({ route, onNavigate, onTicketPageClose }) {
  useStore();
  const state = window.Store.getState();

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
  } else if (route.kind === 'dashboard') page = <Dashboard setRoute={onNavigate}/>;
  else if (route.kind === 'tracker') page = <TrackerBoard route={route} setRoute={onNavigate} view={route.view}/>;
  else if (route.kind === 'specs') page = <SpecsPage/>;
  else if (route.kind === 'projects') page = <ProjectsPage setRoute={onNavigate}/>;
  else if (route.kind === 'agents') page = <AgentsPage setRoute={onNavigate}/>;
  else if (route.kind === 'logs') page = <LogsPage/>;
  else if (route.kind === 'settings') page = <SettingsPage/>;
  else if (route.kind === 'project') page = (
    <ProjectView projectId={route.id} tab={route.tab} showArchived={route.showArchived} q={route.q} setRoute={onNavigate}/>
  );
  else if (route.kind === 'ticket') page = (
    // Standalone ticket page (TKT-0154): reuses TicketDrawer in page variant so
    // the full interactive detail (body, annotations, field controls, dispatch,
    // comments) lives at /tickets/<id> — deep-linkable, refresh-safe.
    <TicketDrawer variant="page" open={true} ticketId={route.id}
      onClose={onTicketPageClose}/>
  );
  else page = <Dashboard setRoute={onNavigate}/>;

  return page;
}

export function LegacyDashboardOverlays({ overlays, onClose }) {
  return (
    <>
      <CeoChatDrawer
        open={!!overlays.chat}
        sessionId={overlays.chat}
        onClose={() => onClose('chat')}/>
      <NativeSessionDrawer
        open={!!overlays.ns}
        sessionId={overlays.ns}
        onClose={() => onClose('ns')}/>
      <CommunicationDrawer
        open={!!overlays.communication}
        onClose={() => onClose('communication')}/>
      <CreateTicketDrawer
        open={!!overlays.compose}
        preselectProject={overlays.composeProject || ''}
        preselectKind={overlays.composeKind || ''}
        preselectParent={overlays.composeParent || ''}
        onClose={() => onClose('compose')}/>
      <TicketDrawer
        open={!!overlays.ticket}
        ticketId={overlays.ticket}
        onClose={() => onClose('ticket')}/>
      <IdeasDrawer
        open={!!overlays.ideas}
        onClose={() => onClose('ideas')}/>
    </>
  );
}

export function LegacyDashboardApp() {
  useStore();
  const [route, setRoute] = React.useState(() => window.Router.parseLocation());

  React.useEffect(() => {
    const sync = () => setRoute(window.Router.parseLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener('route-change', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('route-change', sync);
    };
  }, []);

  const navigate = (next) => window.Router.go(next);

  return (
    <div className="app">
      <Sidebar route={route} setRoute={navigate}/>
      <div className="main">
        <Topbar route={route} setRoute={navigate}/>
        <LegacyDashboardPageBody
          onNavigate={navigate}
          onTicketPageClose={() => window.history.back()}
          route={route}/>
      </div>
      <LegacyDashboardOverlays
        onClose={(name) => window.Router.closeOverlay(name)}
        overlays={route.overlays}/>
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
  root.render(window.React.createElement(LegacyDashboardApp));
}
// GOL-38 imports the current application as a compatibility island. Its typed
// host owns the root and feeds the legacy Store a normalized projection, while
// direct legacy boot keeps its existing standalone behavior until cutover.
if (!window.__GOLEM_TYPED_SHELL__) mount();
