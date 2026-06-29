// Native session drawer (v4) — slides in from the right when a native session
// card is clicked. Body = metadata + recent central-journal activity +
// milestones, fetched on open via Store.loadNativeSessionPeek().

// Thin wrapper kept for existing call sites (dashboard.jsx, other-pages.jsx).
// Now routes through the URL overlay (?ns=<sid>) so Back closes the drawer.
function openNativeSessionDrawer(sessionId) {
  window.Router.openNativeSession(sessionId ?? null);
}

function NativeSessionDrawer({ open, sessionId, onClose }) {
  useStore();

  // open + sessionId are URL-driven (?ns=<sid>, owned by App). On open, fetch
  // the session's recent activity + milestones.
  React.useEffect(() => {
    if (open && sessionId) window.Store.loadNativeSessionPeek(sessionId);
  }, [open, sessionId]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  React.useEffect(() => {
    if (!open || !sessionId) return;
    const id = setInterval(() => {
      const s = window.Store.getNativeSessionById(sessionId);
      if (s && s.alive) window.Store.loadNativeSessionPeek(sessionId);
    }, 5000);
    return () => clearInterval(id);
  }, [open, sessionId]);

  const session = sessionId ? window.Store.getNativeSessionById(sessionId) : null;
  const peek = sessionId ? window.Store.getNativeSessionPeek(sessionId) : null;
  const s = session || peek?.session || null;

  if (!sessionId) {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
        <aside className={`drawer ${open ? 'open' : ''}`}/>
      </>
    );
  }

  const alive = s?.alive;
  const statusKind = !s ? 'idle'
    : !alive ? 'dead'
    : s.status === 'busy' ? 'busy'
    : s.status === 'waiting' ? 'waiting'
    : 'idle';
  const dotClass = statusKind === 'busy' ? 'live'
    : statusKind === 'waiting' ? 'waiting'
    : statusKind === 'idle' ? 'idle'
    : 'offline';
  const statusLabel = statusKind === 'busy' ? 'Working'
    : statusKind === 'waiting' ? 'Waiting'
    : statusKind === 'idle' ? 'Idle'
    : 'Dead';

  const title = s?.name
    || (s?.cwd ? s.cwd.split('/').filter(Boolean).pop() : null)
    || (sessionId ? sessionId.slice(0, 8) : 'session');

  const project = s ? window.Store.getProjectByContractId(s.project_id) : null;
  const registered = (s && (s.registered || !!project));

  const events = peek?.events ?? [];
  const milestones = peek?.milestones ?? [];
  const loaded = !!peek;

  const metaRows = [
    ['cwd', s?.cwd || '—', true],
    ['pid', s?.pid != null ? String(s.pid) : '—', true],
    ['session_id', sessionId, true],
    ['project', s?.project_id || '—', true],
    ['started', s?.started_at ? window.SubstrateFmt.fmtTimeAgo(s.started_at) : '—', false],
    ['updated', s?.updated_at ? window.SubstrateFmt.fmtTimeAgo(s.updated_at) : '—', false],
    ['transcript', peek?.transcript_path || (loaded ? 'not found' : '…'), true],
  ];

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
      <aside className={`drawer ${open ? 'open' : ''}`}>
        <div className="drawer-header">
          <div className="drawer-title-row">
            <span className={`orch-dot ${dotClass}`} style={{ flexShrink: 0 }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="drawer-title" title={s?.cwd || ''}>{title}</h2>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={`nsd-status status-${statusKind}`}>{statusLabel}</span>
                {project
                  ? <><span>·</span><span style={{ color: project.color }}>{project.name}</span></>
                  : registered
                    ? <><span>·</span><span>{s?.project_id || ''}</span></>
                    : <><span>·</span><span style={{ color: 'var(--status-blocked)' }}>unregistered</span></>}
              </div>
            </div>
            <button className="drawer-close" onClick={onClose}><Icon.Close/></button>
          </div>
        </div>

        <div className="drawer-body">
          <div className="nsd-meta-grid">
            {metaRows.map(([k, v, mono]) => (
              <React.Fragment key={k}>
                <div className="nsd-meta-key">{k}</div>
                <div className={`nsd-meta-val ${mono ? 'mono' : ''}`} title={String(v)}>{v}</div>
              </React.Fragment>
            ))}
          </div>

          <div className="nsd-section-head">
            Recent activity
            <span className="nsd-section-count tnum">{events.length}</span>
          </div>
          {!loaded ? (
            <div className="empty">loading…</div>
          ) : events.length === 0 ? (
            <div className="empty">
              {peek?.note || 'no central-journal activity for this session'}
            </div>
          ) : (
            <div className="nsd-events">
              {events.map((e, i) => (
                <div key={`${e.t}-${i}`} className="nsd-event">
                  <span className="nsd-event-time mono">{window.SubstrateFmt.fmtTimeAgo(e.t)}</span>
                  <span className={`nsd-event-type type-${e.event}`}>{e.event}</span>
                  <span className="nsd-event-summary" title={e.summary}>{e.summary}</span>
                </div>
              ))}
            </div>
          )}

          {milestones.length > 0 && (
            <>
              <div className="nsd-section-head">
                Milestones
                <span className="nsd-section-count tnum">{milestones.length}</span>
              </div>
              <ul className="nsd-milestones">
                {milestones.map((m, i) => (
                  <li key={`${m.t}-${i}`} className="nsd-milestone">
                    <span className="nsd-milestone-dot"/>
                    <span className="nsd-milestone-text">{m.text}</span>
                    <span className="nsd-milestone-ts mono">{window.SubstrateFmt.fmtTimeAgo(m.t)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

window.NativeSessionDrawer = NativeSessionDrawer;
window.openNativeSessionDrawer = openNativeSessionDrawer;
