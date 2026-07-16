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
    if (!open || !sessionId) return;
    const id = setInterval(() => {
      const s = window.Store.getNativeSessionById(sessionId);
      if (s && s.alive) window.Store.loadNativeSessionPeek(sessionId);
    }, 5000);
    return () => clearInterval(id);
  }, [open, sessionId]);

  // TKT-0286: this session's pending dispatch queue (FIFO). Refetch on open +
  // on the dispatch-queue-updated WS signal (rev). Cancel relies on the same
  // signal for refresh — no polling.
  const dispatchQueueRev = window.Store.getState().dispatchQueueRev || 0;
  const [queue, setQueue] = React.useState([]);
  React.useEffect(() => {
    if (!open || !sessionId) { setQueue([]); return; }
    let cancelled = false;
    window.SubstrateAPI.getJSON(`/api/dispatch-queue?session=${encodeURIComponent(sessionId)}`)
      .then((rows) => { if (!cancelled) setQueue(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setQueue([]); });
    return () => { cancelled = true; };
  }, [open, sessionId, dispatchQueueRev]);

  const session = sessionId ? window.Store.getNativeSessionById(sessionId) : null;
  const peek = sessionId ? window.Store.getNativeSessionPeek(sessionId) : null;
  const s = session || peek?.session || null;

  if (!sessionId) {
    return (
      <>
        <DrawerBackdrop open={open} onClose={onClose}/>
        <DrawerPanel open={open} onClose={onClose} label="Agent details"/>
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
  const currentTicket = s?.current_in_progress_ticket ?? null;
  const pendingCount = Number(s?.pending_count || queue.length || 0);
  const channelUnavailable = s?.channel_present === false
    || (s?.channel_present === true && ['unreachable', 'unverified', 'unhealthy'].includes(s?.endpoint_health))
    || (s?.channel_present == null && s?.reachable === false);
  const endpointLabel = s?.endpoint_health
    ?? (s?.reachable === true ? 'healthy' : s?.reachable === false ? 'unreachable' : 'unknown');
  const deliveryLabel = s?.delivery_ready === true
    ? 'ready'
    : s?.delivery_reason
      ? `not ready · ${s.delivery_reason}`
      : s?.reachable === false ? 'not ready' : 'unknown';

  const metaRows = [
    ['name', s?.name || '—', false],
    ['harness', s?.harness || 'claudecode', true],
    ['cwd', s?.cwd || '—', true],
    ['pid', s?.pid != null ? String(s.pid) : '—', true],
    ['session_id', sessionId, true],
    ['project', s?.project_id || '—', true],
    ['started', s?.started_at ? window.SubstrateFmt.fmtTimeAgo(s.started_at) : '—', false],
    ['last seen', s?.last_seen_at || s?.updated_at ? window.SubstrateFmt.fmtTimeAgo(s.last_seen_at || s.updated_at) : 'unknown', false],
    ['process', s?.alive ? 'alive' : 'not alive', false],
    ['endpoint', endpointLabel, false],
    ['delivery', deliveryLabel, false],
    ['transcript', peek?.transcript_path || (loaded ? 'not found' : '…'), true],
  ];

  return (
    <>
      <DrawerBackdrop open={open} onClose={onClose}/>
      <DrawerPanel open={open} onClose={onClose} label={`Agent details: ${title}`}>
        <div className="drawer-header">
          <div className="drawer-title-row">
            <span className={`orch-dot ${dotClass}`} style={{ flexShrink: 0 }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="drawer-title" title={s?.cwd || ''}>{title}</h2>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={`nsd-status status-${statusKind}`}>{statusLabel}</span>
                {s?.role && <span className="native-session-role-chip">{s.role}</span>}
                {pendingCount > 0 && <span className="native-session-queue-chip" title={`${pendingCount} queued dispatch${pendingCount === 1 ? '' : 'es'}`}>⏳ {pendingCount}</span>}
                {project
                  ? <><span>·</span><span style={{ color: project.color }}>{project.name}</span></>
                  : registered
                    ? <><span>·</span><span>{s?.project_id || ''}</span></>
                    : <><span>·</span><span style={{ color: 'var(--status-blocked)' }}>unregistered</span></>}
                {s?.alive && channelUnavailable && <><span>·</span><span className="nsd-nochannel">no channel</span></>}
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

          {currentTicket && (
            <a
              className="nsd-current-ticket mono"
              href={window.Router.buildHref({ kind: 'ticket', id: currentTicket.id })}
              onClick={(e) => { e.preventDefault(); window.Router.openTicket(currentTicket.id); }}
              title={currentTicket.title}
            >
              current: {currentTicket.display_id || currentTicket.id} · {currentTicket.title}
            </a>
          )}

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

          {queue.length > 0 && (
            <>
              <div className="nsd-section-head">
                Dispatch queue
                <span className="nsd-section-count tnum">{queue.length}</span>
              </div>
              <div className="nsd-queue">
                {queue.map((r, i) => (
                  <NsdQueueRow key={r.id} row={r} position={i + 1}/>
                ))}
              </div>
            </>
          )}
        </div>
      </DrawerPanel>
    </>
  );
}

// TKT-0286: one row of the session's dispatch queue inside the peek drawer.
// Position (FIFO), ticket id + title (link), note (one-line truncated),
// queued-ago, Cancel. Cancel relies on the dispatch-queue-updated WS signal
// for refresh.
function NsdQueueRow({ row, position }) {
  const [err, setErr] = React.useState(null);
  const cancel = () => {
    setErr(null);
    window.SubstrateAPI.delJSON(`/api/dispatch-queue/${encodeURIComponent(row.id)}`)
      .catch((e) => setErr(String(e?.message || e)));
  };
  const t = Date.parse(row.created_at);
  const ago = Number.isFinite(t) ? (window.SubstrateFmt?.fmtTimeAgo?.(t) || '') : '';
  const note = row.note ? (row.note.length > 60 ? row.note.slice(0, 60) + '…' : row.note) : null;
  return (
    <div className="nsd-queue-row">
      <span className="nsd-queue-pos tnum">{position}</span>
      <a className="nsd-queue-ticket"
        href={window.Router.buildHref({ kind: 'ticket', id: row.ticket_id })}
        onClick={(e) => { e.preventDefault(); window.Router.openTicket(row.ticket_id); }}
        title={row.ticket_title || row.ticket_id}
      >
        <span className="mono">{row.ticket_id}</span>
        {row.ticket_title ? <span className="nsd-queue-title">{row.ticket_title}</span> : null}
      </a>
      {note && <span className="nsd-queue-note" title={row.note}>{note}</span>}
      <span className="nsd-queue-ago" title={row.created_at}>{ago}</span>
      <button className="orch-btn small ghost nsd-queue-cancel" onClick={cancel} title="Cancel this queued dispatch">Cancel</button>
      {err && <div className="nsd-queue-rowerr">{err}</div>}
    </div>
  );
}

window.NativeSessionDrawer = NativeSessionDrawer;
window.openNativeSessionDrawer = openNativeSessionDrawer;
