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
                    <div className={`journal-bubble ${e.kind === 'system' ? 'system' : ''} ${e.kind === 'milestone' ? 'milestone' : ''}`}>{e.text}</div>
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

// ── Native-session drawer (fix round 2, defect 1) ──────────────────────────
// Slides in from the right when a native session card is clicked anywhere
// (home rail / Agents page / project view). Driven by a global
// `open-native-session-drawer` CustomEvent carrying { sessionId } — mirrors the
// CeoChatDrawer's open-event pattern, so card variants only need to dispatch
// the event rather than thread open/close state through every page.
//
// Body = a metadata grid + recent central-journal activity (newest first) +
// milestones, fetched on open via Store.loadNativeSessionPeek(). Reuses the
// .drawer-* slide-in shell from styles.css; .nsd-* additions live in extra.css.
function openNativeSessionDrawer(sessionId) {
  window.dispatchEvent(new CustomEvent('open-native-session-drawer', { detail: { sessionId: sessionId ?? null } }));
}

function NativeSessionDrawer() {
  useStore();
  const [open, setOpen] = React.useState(false);
  const [sessionId, setSessionId] = React.useState(null);

  // Open on the global event; fetch the peek payload.
  React.useEffect(() => {
    const opener = (e) => {
      const sid = e?.detail?.sessionId ?? null;
      setSessionId(sid);
      setOpen(true);
      if (sid) window.Store.loadNativeSessionPeek(sid);
    };
    window.addEventListener('open-native-session-drawer', opener);
    return () => window.removeEventListener('open-native-session-drawer', opener);
  }, []);

  const onClose = React.useCallback(() => setOpen(false), []);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Refresh the peek periodically while the drawer is open and the session is
  // alive (new tool calls / milestones land in the central journal).
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
  // The peek payload carries its own session snapshot (covers a session that
  // dropped out of the live list between click and fetch).
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
          {/* Metadata grid */}
          <div className="nsd-meta-grid">
            {metaRows.map(([k, v, mono]) => (
              <React.Fragment key={k}>
                <div className="nsd-meta-key">{k}</div>
                <div className={`nsd-meta-val ${mono ? 'mono' : ''}`} title={String(v)}>{v}</div>
              </React.Fragment>
            ))}
          </div>

          {/* Recent activity */}
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

          {/* Milestones */}
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
