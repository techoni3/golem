// Agents / Projects / Logs pages. All read live store.

function UnackedDispatchBadge({ warning, compact = false }) {
  if (!warning) return null;
  const ticketId = warning.ticket_id;
  const deliveryId = warning.delivery_event_id;
  const label = warning.display_id || ticketId || 'ticket';
  const deliveredMs = warning.delivered_at ? Date.parse(warning.delivered_at) : NaN;
  const age = Number.isFinite(deliveredMs) ? window.SubstrateFmt?.fmtTimeAgo?.(deliveredMs) : null;
  const session = warning.session_label || warning.session_id || 'target session';
  const title = [
    `dispatch to ${session} appears unacknowledged`,
    warning.delivered_at ? `delivered ${warning.delivered_at}` : null,
    warning.window_minutes != null ? `${warning.window_minutes}m window` : null,
    warning.title || null,
  ].filter(Boolean).join(' · ');
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ticketId) window.Router.openTicket(ticketId);
  };
  const dismiss = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ticketId || deliveryId == null) return;
    window.SubstrateAPI.dismissUnackedDispatch(ticketId, deliveryId).catch((err) => console.error('dismiss unacked failed', err));
  };
  return (
    <span className="unacked-dispatch-badge" title={title} onClick={open} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(e); }}>
      <span>⚠ {compact ? label : `${label}${age ? ` · ${age}` : ''}`}</span>
      <button className="unacked-dispatch-dismiss" title="dismiss warning" onClick={dismiss} disabled={!ticketId || deliveryId == null}>×</button>
    </span>
  );
}

window.UnackedDispatchBadge = UnackedDispatchBadge;

function compactPath(p) {
  if (!p) return '—';
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `.../${parts.slice(-2).join('/')}`;
}

function AgentsPage({ setRoute }) {
  useStore();
  const all = window.Store.getNativeSessions();
  const rolesRev = window.Store.getRolesRev ? window.Store.getRolesRev() : 0;

  // v4: the server already pid-checks native sessions and marks them .alive.
  // Drop anything not alive so dead registry rows / stale CLI entries never
  // render on the Agents page.
  const alive = all.filter((s) => s.alive);

  // TKT-0286: all pending dispatch-queue rows (enriched with ticket_title +
  // session_label by listDispatchQueue). Refetch on the dispatch-queue-updated
  // WS signal (rev) — no polling. Grouped by session for the card chip; rows
  // whose target session is no longer alive surface as offline orphans.
  const dispatchQueueRev = window.Store.getState().dispatchQueueRev || 0;
  const [queue, setQueue] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    window.SubstrateAPI.getJSON('/api/dispatch-queue')
      .then((rows) => { if (!cancelled) setQueue(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setQueue([]); });
    return () => { cancelled = true; };
  }, [dispatchQueueRev]);
  const queueBySession = React.useMemo(() => {
    const m = new Map();
    for (const r of queue) {
      const arr = m.get(r.session_id) ?? [];
      arr.push(r);
      m.set(r.session_id, arr);
    }
    return m;
  }, [queue]);
  const aliveIds = new Set(alive.map((s) => s.session_id));
  const orphans = queue.filter((r) => !aliveIds.has(r.session_id));

  // Disambiguate duplicate session names by appending project name + short sid.
  const nameCounts = {};
  for (const s of alive) {
    const key = s.name || '';
    nameCounts[key] = (nameCounts[key] || 0) + 1;
  }
  const formatName = (s) => {
    const base = s.name || s.session_id?.slice(0, 8) || `pid ${s.pid}`;
    if ((nameCounts[s.name || ''] || 0) <= 1) return base;
    const project = window.Store.getProjectByContractId(s.project_id);
    const suffix = project?.name || s.project_id || s.session_id?.slice(0, 8) || String(s.pid);
    return `${base} · ${suffix}`;
  };

  const isWorking = (s) => s.status === 'busy' || s.status === 'waiting';
  const byRecency = (a, b) => (b.updated_at ?? b.started_at ?? 0) - (a.updated_at ?? a.started_at ?? 0);
  const working = alive.filter(isWorking).sort(byRecency);
  const idle = alive.filter((s) => !isWorking(s)).sort(byRecency);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <div className="page-subtitle">{alive.length} native Claude Code session{alive.length === 1 ? '' : 's'} online.</div>
        </div>
      </div>

      <RolesPanel rev={rolesRev}/>

      {alive.length === 0 && orphans.length === 0 ? (
        <EmptyCard
          label="no native sessions online"
          hint={<>Start a <span className="mono">claude</span> session to bring agents online.</>}
        />
      ) : (
        <>
          {working.length > 0 && (
            <div className="agents-section">
              <div className="agents-section-head">
                <Icon.Gear size={16} className="gear gear-working"/>
                <span className="agents-section-title">Working</span>
                <span className="agents-section-count">{working.length}</span>
              </div>
              <div className="native-sessions">
                {working.map((s) => (
                  <AgentCard key={s.session_id || s.pid} session={s} name={formatName(s)} queueCount={queueBySession.get(s.session_id)?.length || 0} setRoute={setRoute}/>
                ))}
              </div>
            </div>
          )}

          {idle.length > 0 && (
            <div className="agents-section">
              <div className="agents-section-head">
                <Icon.Gear size={16} className="gear gear-idle"/>
                <span className="agents-section-title">Idle</span>
                <span className="agents-section-count">{idle.length}</span>
              </div>
              <div className="native-sessions">
                {idle.map((s) => (
                  <AgentCard key={s.session_id || s.pid} session={s} name={formatName(s)} queueCount={queueBySession.get(s.session_id)?.length || 0} setRoute={setRoute}/>
                ))}
              </div>
            </div>
          )}

          {orphans.length > 0 && (
            <OfflineOrphansSection rows={orphans}/>
          )}
        </>
      )}
    </div>
  );
}

function RolesPanel({ rev }) {
  const [roles, setRoles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.SubstrateAPI.listRoles()
      .then((list) => {
        if (cancelled) return;
        setRoles(Array.isArray(list) ? list : []);
        setError(null);
      })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rev]);

  return (
    <div className="agents-section roles-panel">
      <div className="agents-section-head">
        <Icon.Agents size={16}/>
        <span className="agents-section-title">Roles</span>
        <span className="agents-section-count">{roles.length}</span>
        {loading && <span className="roles-save-state">loading…</span>}
        {error && <span className="roles-save-state error">{error}</span>}
      </div>
      <div className="roles-grid">
        {roles.map((role) => <RoleEditor key={role.name} role={role}/>)}
      </div>
    </div>
  );
}

function RoleEditor({ role }) {
  const [body, setBody] = React.useState(role.body || '');
  const [state, setState] = React.useState('saved');
  const [pushResult, setPushResult] = React.useState(null);
  React.useEffect(() => {
    setBody(role.body || '');
    setState('saved');
    setPushResult(null);
  }, [role.name, role.body]);

  React.useEffect(() => {
    if (body === (role.body || '')) return;
    setState('saving');
    const timer = setTimeout(() => {
      window.SubstrateAPI.saveRole(role.name, body)
        .then(() => setState('saved'))
        .catch((err) => setState(err?.payload?.error || err.message || 'save failed'));
    }, 650);
    return () => clearTimeout(timer);
  }, [body, role.name, role.body]);

  const push = () => {
    setPushResult({ state: 'pushing' });
    window.SubstrateAPI.pushRole(role.name)
      .then((result) => setPushResult({ state: 'done', result }))
      .catch((err) => setPushResult({ state: 'error', error: err?.payload?.error || err.message || String(err) }));
  };
  const status = state === 'saved' ? (role.overridden ? `saved override${role.updated_at ? ` · ${window.SubstrateFmt?.fmtTimeAgo?.(role.updated_at) || role.updated_at}` : ''}` : 'using default') : state;
  const pushed = pushResult?.result;
  const okCount = pushed?.results?.filter((r) => r.ok).length ?? 0;
  return (
    <div className="role-editor-card">
      <div className="role-editor-head">
        <div>
          <div className="role-editor-name">{role.name}</div>
          <div className={`roles-save-state ${String(state).includes('failed') || String(state).includes('error') ? 'error' : ''}`}>{status}</div>
        </div>
        <button className="orch-btn" onClick={push} disabled={state === 'saving' || pushResult?.state === 'pushing'}>Update running agents</button>
      </div>
      <textarea
        className="role-editor-body mono"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck="false"
        aria-label={`${role.name} role card`}
      />
      {pushResult?.state === 'pushing' && <div className="roles-push-result">pushing…</div>}
      {pushResult?.state === 'error' && <div className="roles-push-result error">{pushResult.error}</div>}
      {pushed && (
        <div className="roles-push-result">
          pushed to {okCount}/{pushed.count} live {role.name} session{pushed.count === 1 ? '' : 's'}
          {pushed.results?.length > 0 && (
            <div className="roles-push-list">
              {pushed.results.map((r) => <span key={r.session_id} className={`native-session-meta-chip mono ${r.ok ? '' : 'error'}`} title={r.error || r.target || ''}>{r.ok ? 'ok' : 'fail'} · {r.name || r.session_id.slice(0, 8)}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegacyNativeCardUnused({ session, name, queueCount = 0 }) {
  const working = session.status === 'busy' || session.status === 'waiting';
  const registered = session.registered || !!window.Store.getProjectByContractId(session.project_id);
  const pendingCount = Number(session.pending_count || queueCount || 0);
  const currentTicket = session.current_in_progress_ticket;
  const unackedWarnings = session.active_unacked_dispatches || [];
  const pathLabel = compactPath(session.cwd);
  const openPeek = () => {
    if (session.session_id) window.openNativeSessionDrawer(session.session_id);
  };
  return (
    <div
      className={`native-session-card ${working ? 'busy' : 'idle'} cc-clickable`}
      onClick={openPeek}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeek(); } }}
      title="open session details"
    >
      <div className="native-session-top">
        <Icon.Gear size={16} className={`gear gear-${working ? 'working' : 'idle'}`}/>
        <span className="native-session-name">{name}</span>
        {session.role && <span className="native-session-role-chip">{session.role}</span>}
        {pendingCount > 0 && (
          <span className="native-session-queue-chip" title={`${pendingCount} dispatch${pendingCount === 1 ? '' : 'es'} queued — delivers when this session is idle`}>⏳ {pendingCount} queued</span>
        )}
        {unackedWarnings.map((w) => <UnackedDispatchBadge key={w.delivery_event_id || w.warning_event_id} warning={w}/>)}
        <span className={`native-session-status status-${working ? 'busy' : 'idle'}`}>
          {session.status || 'idle'}
          {session.waiting_for ? ` · ${session.waiting_for}` : ''}
        </span>
        {!registered && (
          <span className="native-session-badge" title="this project is not registered with the dashboard">
            unregistered
          </span>
        )}
      </div>
      <div className="native-session-path mono" title={session.cwd || ''}>
        {pathLabel}
      </div>
      {currentTicket && (
        <a
          className="native-session-current mono"
          href={window.Router.buildHref({ kind: 'ticket', id: currentTicket.id })}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.Router.openTicket(currentTicket.id); }}
          title={currentTicket.title}
        >
          current: {currentTicket.display_id || currentTicket.id} · {currentTicket.title}
        </a>
      )}
      {session.reachable === false && session.alive && (
        <div className="native-session-nochannel" title="live session with no golem channel registered — dispatches can queue, but briefs/interrupts cannot be delivered now">
          <span className="cc-nochannel-dot"/>
          no channel — dispatches queue until reachable
        </div>
      )}
      <div className="native-session-meta">
        <span className="native-session-meta-chip mono" title="process id"><span>pid</span>{session.pid ?? '?'}</span>
        {session.session_id && <span className="native-session-meta-chip mono" title={session.session_id}><span>sid</span>{session.session_id.slice(0, 8)}</span>}
        {session.project_id && <span className="native-session-meta-chip mono" title="derived project_id"><span>project</span>{session.project_id}</span>}
        {session.updated_at && (
          <span className="native-session-meta-chip mono" title="last updated">
            <span>seen</span>
            {window.SubstrateFmt?.fmtClock?.(session.updated_at) || ''}
          </span>
        )}
      </div>
      <div className="native-session-role" onClick={(e) => e.stopPropagation()}>
        <label>
          Role{' '}
          <select
            value={session.role || ''}
            onChange={(e) => window.SubstrateAPI.setSessionRole(session.session_id, e.target.value || null).catch((err) => console.error('set role failed', err))}
            disabled={!session.session_id}
          >
            <option value="">clear</option>
            <option value="planner">planner</option>
            <option value="builder">builder</option>
            <option value="researcher">researcher</option>
            <option value="ui-tester">ui-tester</option>
            <option value="general">general</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function ProjectCard({ p, setRoute }) {
  const live = window.Store.getProjectAliveSessions(p).length;
  return (
    <div
      key={p.id}
      className={`project-card ${p.stale ? 'project-card-stale' : ''}`}
      onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
    >
      <div className="project-card-top">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ProjectGlyph project={p}/>
          <div>
            <div className="project-card-name">{p.name}</div>
            <div className="project-card-id mono">{p.id}</div>
          </div>
        </div>
        {live > 0
          ? <span className="pill active"><span className="dot"/>Active</span>
          : <span className="pill idle"><span className="dot"/>Idle</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden' }}>
        {p.description || <span style={{ color: 'var(--text-4)' }}>no description</span>}
      </div>
      <div className="project-card-stats">
        <div className="project-stat">
          <div className="project-stat-value tnum">{live}</div>
          <div className="project-stat-label">live sessions</div>
        </div>
        <div className="project-stat" style={{ marginLeft: 'auto' }}>
          <div className="project-stat-value tnum" style={{ color: p.color }}>
            {Math.round((p.progress || 0) * 100)}%
          </div>
          <div className="project-stat-label">{p.total_tickets} tickets</div>
        </div>
      </div>
      <div className="project-card-progress">
        <div className="project-card-progress-fill"
          style={{ width: `${(p.progress || 0) * 100}%`, background: p.color }}/>
      </div>
      {p.plan && p.plan.total > 0 && (
        <PlanProgress plan={p.plan} color={p.color}/>
      )}
    </div>
  );
}

function ProjectsPage({ setRoute }) {
  useStore();
  const [includeStale, setIncludeStale] = React.useState(false);
  const projects = window.Store.getState().projects;
  const active = projects.filter((p) => !p.stale);
  const stale = projects.filter((p) => p.stale);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <div className="page-subtitle">{active.length} active · {stale.length} stale</div>
        </div>
        <label className="tracker-toggle stale-toggle">
          <input
            type="checkbox"
            checked={includeStale}
            onChange={(e) => setIncludeStale(e.target.checked)}
          />
          Include stale
        </label>
      </div>
      {projects.length === 0 ? (
        <EmptyCard
          label="no projects discovered"
          hint={<>Bootstrap a project under <span className="mono">~/Documents/software/experiments/golem/golem-projects/</span> — the harness will scaffold and register it in-session.</>}
        />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {active.map(p => <ProjectCard key={p.id} p={p} setRoute={setRoute}/>)}
          </div>
          {includeStale && stale.length > 0 && (
            <div className="stale-section">
              <div className="stale-section-head">
                <Icon.Archive size={16}/>
                <span className="stale-section-title">Stale</span>
                <span className="stale-section-count">{stale.length}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                {stale.map(p => <ProjectCard key={p.id} p={p} setRoute={setRoute}/>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const REVIEW_INBOX_LAST_VISIT = 'golem.reviewInbox.lastVisit';

function ticketRef(t) {
  return t?.display_id || t?.id || '';
}

function ticketChangedMs(t) {
  return Date.parse(t?.state_changed_at || t?.updated_at || t?.created_at || '') || 0;
}

function commentChangedMs(c) {
  return Date.parse(c?.updated_at || c?.created_at || '') || 0;
}

function latestClosingComment(comments) {
  const top = (comments || []).filter((c) => !c.parent_id && c.body);
  const closing = top.filter((c) => /closing brief|acceptance checklist|what shipped|testing/i.test(c.body || ''));
  return (closing.length ? closing : top).sort((a, b) => commentChangedMs(b) - commentChangedMs(a))[0] || null;
}

function acceptanceSlice(body) {
  const text = body || '';
  const m = /(^|\n)#{1,4}\s*Acceptance checklist\s*\n([\s\S]*?)(?=\n#{1,4}\s+|$)/i.exec(text);
  if (m) return m[2].trim();
  const bullets = text.split('\n').filter((line) => /^\s*- \[[ xX]\]/.test(line));
  return bullets.length ? bullets.join('\n') : '';
}

function reviewGroupFor(ticket, parent) {
  const project = window.Store.getProjectByContractId(ticket.project_id);
  if (parent && parent.kind === 'spec') {
    return {
      key: `spec:${parent.id}`,
      title: parent.title || ticketRef(parent),
      subtitle: `${ticketRef(parent)} · ${project?.name || ticket.project_id}`,
      project,
      project_id: ticket.project_id,
    };
  }
  if (!ticket.parent_id && ticket.kind === 'fix') {
    return {
      key: `fixes:${ticket.project_id}`,
      title: `${project?.name || ticket.project_id} fixes`,
      subtitle: 'Spec-less review fixes',
      project,
      project_id: ticket.project_id,
    };
  }
  return {
    key: `other:${ticket.parent_id || ticket.project_id}`,
    title: parent?.title || `${project?.name || ticket.project_id} review`,
    subtitle: parent ? `${ticketRef(parent)} · ${project?.name || ticket.project_id}` : 'Ungrouped review tickets',
    project,
    project_id: ticket.project_id,
  };
}

function buildReviewGroups(items, projectFilter) {
  const groups = new Map();
  for (const item of items) {
    if (projectFilter && item.ticket.project_id !== projectFilter) continue;
    const meta = reviewGroupFor(item.ticket, item.parent);
    if (!groups.has(meta.key)) groups.set(meta.key, { ...meta, items: [] });
    groups.get(meta.key).items.push(item);
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => ticketChangedMs(b.ticket) - ticketChangedMs(a.ticket));
    g.changed = g.items.reduce((max, item) => Math.max(max, ticketChangedMs(item.ticket)), 0);
  }
  return [...groups.values()].sort((a, b) => b.changed - a.changed);
}

function ReviewInboxEntry({ item, lastVisitMs, onRefresh }) {
  const ticket = item.ticket;
  const brief = latestClosingComment(ticket.comments || []);
  const checklist = acceptanceSlice(brief?.body || '');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState('');
  const changed = ticketChangedMs(ticket);
  const fresh = lastVisitMs && changed > lastVisitMs;
  const owningSession = ticket.assignee || ticket.dispatched_to || null;

  const accept = async () => {
    setBusy('accept');
    setError('');
    try {
      await window.SubstrateAPI.updateTicket(ticketRef(ticket), { state: 'done', actor: 'human:review-inbox' });
      await onRefresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(null);
    }
  };

  const sendBack = async () => {
    if (!note.trim()) { setError('Add a send-back note first.'); return; }
    setBusy('send');
    setError('');
    try {
      await window.SubstrateAPI.addComment(ticketRef(ticket), { author: 'human:review-inbox', body: note.trim(), tag: 'fix' });
      await window.SubstrateAPI.updateTicket(ticketRef(ticket), { state: 'in_progress', actor: 'human:review-inbox' });
      if (owningSession) {
        const live = await window.SubstrateAPI.listDispatchable(ticket.project_id);
        if ((live || []).some((s) => s.session_id === owningSession)) {
          await window.SubstrateAPI.dispatchTicket(ticketRef(ticket), {
            session_id: owningSession,
            note: note.trim(),
            mode: 'now',
          });
        }
      }
      setNote('');
      await onRefresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 10, borderColor: fresh ? 'var(--accent)' : undefined }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <a href={window.Router.buildHref({ kind: 'ticket', id: ticketRef(ticket) })}
            onClick={(e) => { e.preventDefault(); window.Router.openTicket(ticketRef(ticket)); }}
            className="mono"
            style={{ fontSize: 12 }}
          >{ticketRef(ticket)}</a>
          <div style={{ fontWeight: 700, marginTop: 3 }}>{ticket.title}</div>
          <div className="cc-feed-meta" style={{ marginTop: 5 }}>
            <ProjectChip project={window.Store.getProjectByContractId(ticket.project_id)} projectId={ticket.project_id} registered/>
            <span className="mono">review since {window.SubstrateFmt?.fmtTimeAgo?.(changed) || ''}</span>
            {fresh ? <span className="pill">new since last visit</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="orch-btn small" disabled={!!busy} onClick={accept}>{busy === 'accept' ? 'Accepting…' : 'Accept'}</button>
        </div>
      </div>
      {checklist ? (
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,.03)' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>acceptance checklist</div>
          <div className="td-body" dangerouslySetInnerHTML={{ __html: window.SubstrateFmt?.renderMarkdown?.(checklist) || checklist }}/>
        </div>
      ) : null}
      <div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>closing brief</div>
        {brief ? (
          <div className="td-body" dangerouslySetInnerHTML={{ __html: window.SubstrateFmt?.renderMarkdown?.(brief.body) || brief.body }}/>
        ) : (
          <div className="empty" style={{ padding: 10 }}>No closing brief comment found.</div>
        )}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <textarea
          className="td-comment-textarea"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Send back note — posts a comment, returns to in_progress, and re-dispatches to the owning live session when available."
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="orch-btn small ghost" disabled={!!busy} onClick={sendBack}>{busy === 'send' ? 'Sending…' : 'Send back'}</button>
          {owningSession ? <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>owner {owningSession.slice(0, 12)}</span> : <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>no owning session</span>}
        </div>
        {error ? <div className="orphan-row-err">{error}</div> : null}
      </div>
    </div>
  );
}

function ReviewInbox({ projectFilter, setProjectFilter, lastVisitMs }) {
  const projects = window.Store.getProjects();
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const review = await window.SubstrateAPI.listReviewTickets();
      const detailed = await Promise.all((review || []).map(async (t) => {
        const full = await window.SubstrateAPI.getTicket(ticketRef(t));
        window.Store.upsertTrackerTicket(full);
        window.Store.seedTicketComments(full.id, full.comments || []);
        return full;
      }));
      const parents = new Map();
      await Promise.all([...new Set(detailed.map((t) => t.parent_id).filter(Boolean))].map(async (pid) => {
        try { parents.set(pid, await window.SubstrateAPI.getTicket(pid)); } catch { /* parent may belong to an old/imported project */ }
      }));
      setItems(detailed.map((ticket) => ({ ticket, parent: parents.get(ticket.parent_id) || null })));
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { load(); }, []);
  const groups = buildReviewGroups(items, projectFilter);
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="mono" style={{ color: 'var(--text-2)' }}>{loading ? 'loading review tickets…' : `${count} review ticket${count === 1 ? '' : 's'}`}</div>
        <select className="tracker-select" value={projectFilter || ''} onChange={(e) => setProjectFilter(e.target.value || '')}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.project_id || p.id} value={p.project_id || p.id}>{p.name}</option>)}
        </select>
      </div>
      {error ? <div className="orphan-row-err">{error}</div> : null}
      {!loading && groups.length === 0 ? (
        <EmptyCard label="no review tickets" hint={<>Review-state tickets across projects will appear here with their closing briefs.</>}/>
      ) : null}
      {groups.map((g) => {
        let markerShown = false;
        return (
          <section key={g.key} className="card" style={{ padding: 14, display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>{g.title}</div>
                <div className="cc-feed-meta" style={{ marginTop: 4 }}>
                  <ProjectChip project={g.project} projectId={g.project_id} registered/>
                  <span className="mono">{g.subtitle}</span>
                </div>
              </div>
              <span className="pill">{g.items.length}</span>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {g.items.map((item) => {
                const changed = ticketChangedMs(item.ticket);
                const showMarker = lastVisitMs && !markerShown && changed <= lastVisitMs;
                if (showMarker) markerShown = true;
                return (
                  <React.Fragment key={item.ticket.id}>
                    {showMarker ? <div className="mono" style={{ color: 'var(--text-3)', fontSize: 11, textAlign: 'center' }}>since you last looked</div> : null}
                    <ReviewInboxEntry item={item} lastVisitMs={lastVisitMs} onRefresh={load}/>
                  </React.Fragment>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function MilestonesFeed() {
  const milestones = window.Store.getRecentMilestones();
  return milestones.length === 0 ? (
    <EmptyCard
      label="no recent activity"
      hint={<>Sessions append milestones as work lands — they appear here and on the command center home.</>}
    />
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
                <ProjectChip project={project} projectId={m.project} registered/>
                <span className="cc-feed-ts mono">{window.SubstrateFmt.fmtTimeAgo(m.t)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function LogsPage() {
  useStore();
  const [tab, setTab] = React.useState('review');
  const [projectFilter, setProjectFilter] = React.useState('');
  const [lastVisitMs] = React.useState(() => Number(window.localStorage?.getItem(REVIEW_INBOX_LAST_VISIT) || 0) || 0);

  React.useEffect(() => {
    if (tab !== 'review') return;
    window.localStorage?.setItem(REVIEW_INBOX_LAST_VISIT, String(Date.now()));
  }, [tab]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Review Inbox</h1>
          <div className="page-subtitle">Closing briefs for review-state tickets, grouped by parent spec.</div>
        </div>
        <div className="topbar-meta">
          <ConnectionPill status={window.Store.getState().connection}/>
        </div>
      </div>
      <div className="tracker-tabs" style={{ marginBottom: 14 }}>
        <button className={`tracker-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>Review Inbox</button>
        <button className={`tracker-tab ${tab === 'milestones' ? 'active' : ''}`} onClick={() => setTab('milestones')}>Milestones</button>
      </div>
      {tab === 'review' ? (
        <ReviewInbox projectFilter={projectFilter} setProjectFilter={setProjectFilter} lastVisitMs={lastVisitMs}/>
      ) : (
        <MilestonesFeed/>
      )}
    </div>
  );
}

// TKT-0286: pending dispatches whose target session is no longer alive. Named
// via the persisted session_labels join (the live-session list can't resolve
// them). Rendered below Working/Idle on the Agents page; Cancel relies on the
// dispatch-queue-updated WS signal for refresh (no manual refetch, no polling).
function OfflineOrphansSection({ rows }) {
  const [errors, setErrors] = React.useState({});
  const cancel = (qid) => {
    window.SubstrateAPI.delJSON(`/api/dispatch-queue/${encodeURIComponent(qid)}`)
      .catch((err) => setErrors((e) => ({ ...e, [qid]: String(err?.message || err) })));
  };
  const sessionLabel = (r) => r.session_label || `session ${String(r.session_id || '').slice(0, 8)}`;
  const ago = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? (window.SubstrateFmt?.fmtTimeAgo?.(t) || '') : ''; };
  return (
    <div className="agents-section agents-section-orphans">
      <div className="agents-section-head">
        <Icon.Archive size={16}/>
        <span className="agents-section-title">Queued for offline sessions</span>
        <span className="agents-section-count">{rows.length}</span>
      </div>
      <div className="native-sessions">
        {rows.map((r) => (
          <div key={r.id} className="orphan-row">
            <div className="orphan-row-top">
              <span className="orphan-session-label" title={r.session_id}>{sessionLabel(r)}</span>
              <a className="orphan-ticket-link"
                href={window.Router.buildHref({ kind: 'ticket', id: r.ticket_id })}
                onClick={(e) => { e.preventDefault(); window.Router.openTicket(r.ticket_id); }}
                title={r.ticket_title || r.ticket_id}
              >
                <span className="mono">{r.ticket_id}</span>
                {r.ticket_title ? <span className="orphan-ticket-title">{r.ticket_title}</span> : null}
              </a>
              <span className="orphan-ago" title={r.created_at}>{ago(r.created_at)}</span>
              <button className="orch-btn small ghost orphan-cancel" onClick={() => cancel(r.id)} title="Cancel this queued dispatch">Cancel</button>
            </div>
            <div className="orphan-row-hint">expires after 60m offline</div>
            {errors[r.id] && <div className="orphan-row-err">{errors[r.id]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

window.AgentsPage = AgentsPage;
window.ProjectsPage = ProjectsPage;
window.LogsPage = LogsPage;
