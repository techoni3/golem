// Command-center home (v4). Three zones:
//   1. SESSIONS RAIL  — every native Claude Code session: status, what it's
//      stuck on, and per-session controls (brief composer + interrupt/halt
//      when a live channel exists for that session).
//   2. WORK ZONE      — project cards reworked around PLAN.md progress, the
//      latest milestone, and a pending-gate count badge.
//   3. CONTROL & FEED — pending gates (approve/deny/cancel) across projects,
//      plus a cross-project milestone feed (the primary progress signal).
//
// The home renders entirely from the snapshot (native_sessions, channels,
// projects[].plan/.milestones, orchestrator.gates, recent_milestones) — NO
// per-project fetches.

const { useState: useDState, useCallback: useDCallback } = React;

function Dashboard({ setRoute }) {
  useStore();
  const state = window.Store.getState();
  const sessions = window.Store.getNativeSessions();
  const projects = state.projects;
  const gates = window.Store.getPendingGates();
  const milestones = window.Store.getRecentMilestones();

  const aliveCount = sessions.filter((s) => s.alive).length;
  const busyCount = sessions.filter((s) => s.alive && s.status === 'busy').length;
  const waitingCount = sessions.filter((s) => s.alive && s.status === 'waiting').length;

  return (
    <div className="page command-center">
      <div className="page-header">
        <div>
          <h1 className="page-title">Command Center</h1>
          <div className="page-subtitle">
            What is running right now, what it is stuck on, and where every project stands.
          </div>
        </div>
        <div className="cc-headline-stats">
          <CCStat value={aliveCount} label="sessions live" tone="active"/>
          <CCStat value={busyCount} label="working" tone="running"/>
          <CCStat value={waitingCount} label="waiting" tone="review"/>
          <CCStat value={gates.length} label="gates" tone={gates.length ? 'review' : 'muted'}/>
        </div>
      </div>

      <div className="cc-grid">
        {/* ── Zone 1: Sessions rail ── */}
        <section className="cc-zone cc-sessions">
          <div className="cc-zone-head">
            <span className="cc-zone-title">Sessions</span>
            <span className="cc-zone-count">{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <EmptyCard
              label="no Claude Code sessions running"
              hint={<>This rail lists every live <span className="mono">claude</span> session on the machine. Start one with <span className="mono">cd any-repo &amp;&amp; claude</span>.</>}
            />
          ) : (
            <div className="cc-session-list">
              {sessions.map((s) => (
                <SessionCard key={s.session_id || s.pid} session={s} setRoute={setRoute}/>
              ))}
            </div>
          )}
        </section>

        {/* ── Zone 2: Work zone ── */}
        <section className="cc-zone cc-work">
          <div className="cc-zone-head">
            <span className="cc-zone-title">Projects</span>
            <span className="cc-zone-count">{projects.length}</span>
          </div>
          {projects.length === 0 ? (
            <EmptyCard
              label="no projects discovered"
              hint={<>Projects appear as sessions register them, or bootstrap one under <span className="mono">golem-projects/</span>.</>}
            />
          ) : (
            <div className="cc-project-list">
              {projects.map((p) => (
                <WorkCard key={p.id} project={p} gates={gates} setRoute={setRoute}/>
              ))}
            </div>
          )}
        </section>

        {/* ── Zone 3: Control & feed ── */}
        <section className="cc-zone cc-control">
          <PendingGatesPanel gates={gates} setRoute={setRoute}/>
          <MilestoneFeed milestones={milestones} setRoute={setRoute}/>
        </section>
      </div>
    </div>
  );
}

function CCStat({ value, label, tone }) {
  return (
    <div className={`cc-stat tone-${tone || 'muted'}`}>
      <div className="cc-stat-value tnum">{value}</div>
      <div className="cc-stat-label">{label}</div>
    </div>
  );
}

// A small clickable chip linking to a project page (or a quiet "unregistered"
// badge style when the session's project isn't tracked by the dashboard).
//
// `registered` is the server's authoritative flag (native-sessions.js matches
// the session cwd/root against the registry). It can be TRUE even when no local
// project record resolves here — the dashboard `id` (registry id) and the
// derived contract `project_id` differ for most registered projects. So the
// "unregistered" badge keys off `registered`, NOT merely off a missing project
// record: only a genuinely unregistered cwd gets the badge.
function ProjectChip({ project, projectId, registered, setRoute }) {
  if (project) {
    return (
      <button
        className="cc-chip"
        style={{ '--chip-color': project.color }}
        onClick={(e) => { e.stopPropagation(); setRoute && setRoute({ kind: 'project', id: project.id, tab: 'agents' }); }}
        title={`open ${project.name}`}
      >
        <span className="cc-chip-dot" style={{ background: project.color }}/>
        <span className="cc-chip-text">{project.name}</span>
      </button>
    );
  }
  // Registered but no resolvable project record (id/contract-id mismatch, or a
  // project the dashboard summary hasn't surfaced): show the derived id as a
  // quiet chip WITHOUT the unregistered tag.
  if (registered) {
    return (
      <span className="cc-chip" title={projectId ? `registered project — ${projectId}` : 'registered project'}>
        <span className="cc-chip-dot"/>
        <span className="cc-chip-text mono">{projectId ? projectId : '—'}</span>
      </span>
    );
  }
  return (
    <span className="cc-chip cc-chip-unregistered" title={projectId ? `derived project_id: ${projectId} — not registered with the dashboard` : 'no project'}>
      <span className="cc-chip-dot"/>
      <span className="cc-chip-text mono">{projectId ? projectId : '—'}</span>
      <span className="cc-chip-tag">unregistered</span>
    </span>
  );
}

// ── Zone 1: one native session, with status + (channel-gated) controls ──
function SessionCard({ session: s, setRoute }) {
  // Match on the CONTRACT project_id (registry id ≠ contract id for most
  // registered projects), falling back to the server's `registered` flag.
  const project = window.Store.getProjectByContractId(s.project_id);
  const channel = window.Store.getChannelForSession(s.session_id);
  const hasChannel = !!channel;
  const registered = s.registered || !!project;

  const statusKind = !s.alive ? 'dead'
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

  const title = s.name || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null) || (s.session_id ? s.session_id.slice(0, 8) : `pid ${s.pid}`);

  // Whole card opens the native-session peek drawer. Inner controls
  // (composer / Interrupt / Halt / project chip) stopPropagation so they never
  // trigger the drawer.
  const openPeek = () => {
    if (s.session_id) window.openNativeSessionDrawer(s.session_id);
  };

  return (
    <div
      className={`cc-session-card status-${statusKind} cc-clickable`}
      onClick={openPeek}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeek(); } }}
      title="open session details"
    >
      <div className="cc-session-row1">
        <span className={`orch-dot ${dotClass}`}/>
        <span className="cc-session-name" title={s.cwd || ''}>{title}</span>
        <span className={`cc-status-badge badge-${statusKind}`}>
          {statusKind === 'busy' && <span className="cc-status-pulse"/>}
          {statusLabel}
        </span>
      </div>

      {statusKind === 'waiting' && s.waiting_for && (
        <div className="cc-session-waiting" title="what this session is stuck on">
          <Icon.Clock size={12}/>
          <span>{s.waiting_for}</span>
        </div>
      )}

      <div className="cc-session-row2">
        <ProjectChip project={project} projectId={s.project_id} registered={registered} setRoute={setRoute}/>
        <span className="cc-session-ages mono">
          {s.started_at && <span title="started">↑ {window.SubstrateFmt.fmtTimeAgo(s.started_at)}</span>}
          {s.updated_at && s.updated_at !== s.started_at && <span title="updated">· {window.SubstrateFmt.fmtTimeAgo(s.updated_at)}</span>}
        </span>
      </div>

      {s.cwd && <div className="cc-session-cwd mono" title={s.cwd}>{s.cwd}</div>}

      {hasChannel ? (
        <SessionControls session={s} channel={channel}/>
      ) : (
        s.alive && (
          <div className="cc-session-nochannel" onClick={(e) => e.stopPropagation()} title="no golem channel registered for this session — briefs/interrupts cannot be delivered">
            <span className="cc-nochannel-dot"/>
            {/* When the channel mechanism is demonstrably working (other live
                channels exist), this session is simply a pre-v4 holdover that
                needs a restart. Otherwise stay neutral. */}
            {window.Store.getChannels().length > 0
              ? 'no channel (pre-v4 session) — restart to enable controls'
              : 'no channel — controls unavailable'}
          </div>
        )
      )}
    </div>
  );
}

// One-line brief composer + interrupt/halt, shown only when a live channel
// exists for this session. POSTs to the existing /api/brief?session= route.
function SessionControls({ session: s, channel }) {
  const [text, setText] = useDState('');
  const [busy, setBusy] = useDState(false);
  const [toast, setToast] = useDState(null);
  const sid = s.session_id;

  const flash = (msg, kind = 'ok') => {
    setToast({ msg, kind, id: Math.random() });
    setTimeout(() => setToast(null), 2600);
  };

  const run = useDCallback(async (fn, label) => {
    setBusy(true);
    try {
      await fn();
      flash(`${label} sent`, 'ok');
      return true;
    } catch (err) {
      console.error(`${label} failed`, err);
      flash(`${label} failed`, 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const sendBrief = useDCallback(async () => {
    const t = text.trim();
    if (!t || busy) return;
    const ok = await run(() => window.SubstrateAPI.pushBrief(t, sid), 'Brief');
    if (ok) setText('');
  }, [text, busy, sid, run]);

  const onInterrupt = useDCallback(() => {
    const t = text.trim();
    run(() => window.SubstrateAPI.pushInterrupt(t || 'interrupt from dashboard', sid), 'Interrupt');
  }, [text, sid, run]);

  const onHalt = useDCallback(() => {
    if (!confirm(`Halt session ${(sid || '').slice(0, 8)} — gracefully yield after current dispatch?`)) return;
    run(() => window.SubstrateAPI.pushHalt('Halt requested from dashboard', sid), 'Halt');
  }, [sid, run]);

  return (
    <div className="cc-session-controls" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="cc-composer">
        <input
          className="cc-composer-input"
          placeholder="Send a brief to this session…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendBrief(); } }}
          disabled={busy}
        />
        <button className="orch-btn primary small" disabled={busy || !text.trim()} onClick={sendBrief}>Send</button>
      </div>
      <div className="cc-session-buttons">
        <button className="orch-btn small" disabled={busy} onClick={onInterrupt} title="fold a course-correction into in-flight work">Interrupt</button>
        <button className="orch-btn small ghost" disabled={busy} onClick={onHalt} title="gracefully halt this session">Halt</button>
        <span className="cc-channel-tag mono" title={`channel ${channel.url || `${channel.host}:${channel.port}`}`}>:{channel.port}</span>
      </div>
      {toast && <div className={`orch-toast ${toast.kind} cc-toast`} key={toast.id}>{toast.msg}</div>}
    </div>
  );
}

// ── Zone 2: a project card built around PLAN progress + latest milestone ──
function WorkCard({ project: p, gates, setRoute }) {
  // v5b: home progress now comes from the cross-project tracker (tracker.db),
  // not PLAN.md. done = state 'done'; total = non-archived tickets for this
  // project's CONTRACT project_id. Falls back gracefully (no bar) when the
  // project has zero tracker tickets.
  const contractId = p.project_id || p.id;
  const trackerTickets = window.Store.getTrackerTickets({ project_id: contractId });
  const trackerTotal = trackerTickets.length;
  const trackerDone = trackerTickets.filter((t) => t.state === 'done').length;
  const hasTracker = trackerTotal > 0;

  const milestones = p.milestones || [];
  const latest = milestones.length ? milestones[milestones.length - 1] : null;
  const pendingGates = gates.filter((g) => g.workspace === p.id).length;
  const hasActivity = hasTracker || milestones.length > 0;
  const live = window.Store.getProjectActiveAgents(p.id).length;
  const pct = hasTracker ? Math.round((trackerDone / trackerTotal) * 100) : 0;

  // Compact render for projects with no plan + no activity.
  if (!hasActivity) {
    return (
      <button
        className="cc-work-card compact"
        style={{ '--card-color': p.color }}
        onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
      >
        <ProjectGlyph project={p} size={26}/>
        <span className="cc-work-name">{p.name}</span>
        {p.auto && <span className="cc-work-tag">auto</span>}
        {live > 0 && <span className="cc-work-live"><span className="orch-dot live"/>{live}</span>}
      </button>
    );
  }

  return (
    <div
      className="cc-work-card"
      style={{ '--card-color': p.color }}
      onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
    >
      <div className="cc-work-top">
        <ProjectGlyph project={p} size={30}/>
        <div className="cc-work-titlewrap">
          <div className="cc-work-name">{p.name}</div>
          <div className="cc-work-id mono">{p.id}</div>
        </div>
        <div className="cc-work-badges">
          {pendingGates > 0 && (
            <span className="cc-gate-badge" title={`${pendingGates} gate(s) awaiting`}>
              <Icon.Gate size={11}/> {pendingGates}
            </span>
          )}
          {live > 0 && <span className="cc-work-live"><span className="orch-dot live"/>{live}</span>}
        </div>
      </div>

      {hasTracker && (
        <div className="cc-plan">
          <div className="cc-plan-bar">
            <div className="cc-plan-fill" style={{ width: `${pct}%`, background: p.color }}/>
          </div>
          <span className="cc-plan-count tnum">{trackerDone}/{trackerTotal}</span>
          <span className="cc-plan-pct tnum" style={{ color: p.color }}>{pct}%</span>
        </div>
      )}

      {latest ? (
        <div className="cc-work-milestone" title={latest.text}>
          <span className="cc-work-milestone-dot"/>
          <span className="cc-work-milestone-text">{latest.text}</span>
          <span className="cc-work-milestone-ts mono">{window.SubstrateFmt.fmtTimeAgo(latest.t)}</span>
        </div>
      ) : (
        <div className="cc-work-milestone muted">no milestones yet</div>
      )}
    </div>
  );
}

// ── Zone 3a: pending gates across all projects ──
function PendingGatesPanel({ gates, setRoute }) {
  return (
    <div className="cc-panel">
      <div className="cc-zone-head">
        <span className="cc-zone-title">Pending Gates</span>
        <span className={`cc-zone-count ${gates.length ? 'attn' : ''}`}>{gates.length}</span>
      </div>
      {gates.length === 0 ? (
        <div className="cc-panel-empty">No gates awaiting a decision.</div>
      ) : (
        <div className="cc-gate-list">
          {gates.map((g) => <GateRow key={g.gate_id} gate={g} setRoute={setRoute}/>)}
        </div>
      )}
    </div>
  );
}

function GateRow({ gate: g, setRoute }) {
  const [busy, setBusy] = useDState(false);
  const [toast, setToast] = useDState(null);
  // Gate `workspace` is the dashboard registry id; resolve by id (with contract
  // fallback, harmless here). Gates always come from a registered workspace.
  const project = window.Store.getProjectByContractId(g.workspace);

  const flash = (msg, kind = 'ok') => {
    setToast({ msg, kind, id: Math.random() });
    setTimeout(() => setToast(null), 2600);
  };

  const decide = useDCallback(async (decision) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.SubstrateAPI.pushGate(g.gate_id, decision, '', null);
      flash(`${decision}d`, decision === 'deny' ? 'err' : 'ok');
    } catch (err) {
      console.error(`gate ${decision} failed`, err);
      flash(`${decision} failed`, 'err');
    } finally {
      setBusy(false);
    }
  }, [busy, g.gate_id]);

  const kind = g.kind || (String(g.gate_id).startsWith('input-') ? 'input' : 'approval');

  return (
    <div className="cc-gate-row">
      <div className="cc-gate-row-top">
        <ProjectChip project={project} projectId={g.workspace} registered setRoute={setRoute}/>
        <span className="cc-gate-kind">{kind}</span>
      </div>
      <div className="cc-gate-flow">
        {g.phase_just_completed || '?'} <span className="cc-gate-arrow">→</span> {g.next_phase || '?'}
      </div>
      <div className="cc-gate-id mono" title={g.gate_id}>{g.gate_id}</div>
      <div className="cc-gate-actions">
        <button className="orch-btn small ok" disabled={busy} onClick={() => decide('approve')}>Approve</button>
        <button className="orch-btn small" disabled={busy} onClick={() => decide('deny')}>Deny</button>
        <button className="orch-btn small ghost" disabled={busy} onClick={() => decide('cancel')}>Cancel</button>
      </div>
      {toast && <div className={`orch-toast ${toast.kind} cc-toast`} key={toast.id}>{toast.msg}</div>}
    </div>
  );
}

// ── Zone 3b: cross-project milestone feed (primary progress signal) ──
function MilestoneFeed({ milestones, setRoute }) {
  return (
    <div className="cc-panel">
      <div className="cc-zone-head">
        <span className="cc-zone-title">Milestone Feed</span>
        <span className="cc-zone-count">{milestones.length}</span>
      </div>
      {milestones.length === 0 ? (
        <div className="cc-panel-empty">
          No milestones yet. Sessions append them as work lands — they are the primary progress signal.
        </div>
      ) : (
        <ul className="cc-feed">
          {milestones.map((m, i) => {
            const project = window.Store.getProjectByContractId(m.project);
            return (
              <li key={`${m.t}-${i}`} className="cc-feed-item">
                <span className="cc-feed-dot" style={{ background: m.project_color || 'var(--accent)' }}/>
                <div className="cc-feed-body">
                  <div className="cc-feed-text">{m.text}</div>
                  <div className="cc-feed-meta">
                    <ProjectChip project={project} projectId={m.project} registered setRoute={setRoute}/>
                    <span className="cc-feed-ts mono">{window.SubstrateFmt.fmtTimeAgo(m.t)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
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
window.SessionCard = SessionCard;
window.WorkCard = WorkCard;
window.PendingGatesPanel = PendingGatesPanel;
window.GateRow = GateRow;
window.MilestoneFeed = MilestoneFeed;
window.ProjectChip = ProjectChip;
