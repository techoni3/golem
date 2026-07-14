// Shared atoms — adapted from the design's atoms.jsx to use window.Store
// (real role map) instead of the static SubstrateData.ROLES.

function Avatar({ role, size = 32, pulse = false }) {
  const r = window.Store.getRole(role);
  if (!role) {
    return (
      <div className="agent-avatar anon" style={{ width: size, height: size }}>
        {r.glyph}
        {pulse && <span className="agent-avatar-pulse" style={{ color: r.color }}/>}
      </div>
    );
  }
  return (
    <div
      className="agent-avatar"
      style={{
        width: size, height: size,
        background: `color-mix(in oklab, ${r.color} 18%, var(--bg-2))`,
        color: r.color,
        border: `1px solid color-mix(in oklab, ${r.color} 35%, transparent)`,
      }}
    >
      {r.glyph}
      {pulse && <span className="agent-avatar-pulse" style={{ color: r.color }}/>}
    </div>
  );
}

function RoleSelect({ value, disabled, onChange }) {
  const roles = window.Store.getRoles ? window.Store.getRoles() : [];
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
      <option value="">clear</option>
      {roles.map((role) => <option key={role.name} value={role.name}>{role.name}</option>)}
    </select>
  );
}

function ProjectGlyph({ project, size = 32 }) {
  return (
    <div
      className="project-card-glyph"
      style={{
        width: size, height: size,
        background: `color-mix(in oklab, ${project.color} 18%, var(--bg-2))`,
        color: project.color,
        border: `1px solid color-mix(in oklab, ${project.color} 30%, transparent)`,
      }}
    >
      {project.glyph}
    </div>
  );
}

function Carousel({ children, trackRef }) {
  const internalRef = React.useRef(null);
  const ref = trackRef ?? internalRef;
  return (
    <div className="carousel">
      <div className="carousel-track" ref={ref}>{children}</div>
    </div>
  );
}

function CarouselControls({ trackRef }) {
  return (
    <div className="row-controls">
      <button className="icon-btn" onClick={() => trackRef.current?.scrollBy({ left: -360, behavior: 'smooth' })}>
        <Icon.ChevronLeft/>
      </button>
      <button className="icon-btn" onClick={() => trackRef.current?.scrollBy({ left: 360, behavior: 'smooth' })}>
        <Icon.ChevronRight/>
      </button>
    </div>
  );
}

function ConnectionPill({ status }) {
  const cls = status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : '';
  const label = status === 'connected' ? 'Live'
    : status === 'connecting' ? 'Connecting'
    : status === 'disconnected' ? 'Offline'
    : status;
  return (
    <span className={`conn-pill ${cls}`}>
      <span className="dot"/>{label}
    </span>
  );
}

function DrawerBackdrop({ open, onClose }) {
  if (!open) return null;
  return <div className="drawer-backdrop open" onClick={onClose} aria-hidden="true"/>;
}

// One modal authority for every right drawer. Entries are ordered by mount,
// so only the top owns keyboard handling while background inertness derives
// from stack depth rather than any individual drawer's cleanup timing.
const DRAWER_STACK = [];
function syncDrawerBackground() {
  const inert = DRAWER_STACK.length > 0;
  document.querySelectorAll('.app > .sidebar, .app > .main').forEach((node) => {
    node.inert = inert;
    if (inert) node.setAttribute('aria-hidden', 'true');
    else node.removeAttribute('aria-hidden');
  });
  const top = drawerTop();
  DRAWER_STACK.forEach((entry) => {
    const panel = entry.ref.current;
    if (!panel) return;
    const isTop = entry === top;
    panel.inert = !isTop;
    panel.setAttribute('aria-hidden', isTop ? 'false' : 'true');
    if (isTop) panel.setAttribute('aria-modal', 'true');
    else panel.removeAttribute('aria-modal');
    panel.dataset.modalTop = isTop ? 'true' : 'false';
  });
}
function drawerTop() { return DRAWER_STACK[DRAWER_STACK.length - 1] || null; }

function DrawerPanel({ open, onClose, label = 'Details', className = '', children, ...props }) {
  const ref = React.useRef(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const focusKey = previous?.getAttribute?.('data-focus-key');
    const entry = { ref, previous, focusKey };
    DRAWER_STACK.push(entry);
    syncDrawerBackground();
    ref.current?.focus();
    const onKey = (event) => {
      if (drawerTop() !== entry) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(ref.current?.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
        .filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { event.preventDefault(); ref.current?.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const index = DRAWER_STACK.indexOf(entry);
      if (index >= 0) DRAWER_STACK.splice(index, 1);
      syncDrawerBackground();
      const target = previous?.isConnected ? previous : (focusKey ? document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) : null);
      if (index >= DRAWER_STACK.length) (target || drawerTop()?.ref?.current)?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <aside ref={ref} className={`drawer open${className ? ` ${className}` : ''}`}
      role="dialog" aria-label={label} tabIndex={-1} {...props}>
      {children}
    </aside>
  );
}
window.DrawerBackdrop = DrawerBackdrop;
window.DrawerPanel = DrawerPanel;

// v4: PLAN.md progress — a compact "N/M" bar that expands to the flat
// checkbox-item list on click. Renders nothing when the project has no plan.
// `color` themes the fill bar to match the project.
function PlanProgress({ plan, color, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);
  if (!plan || !plan.total) return null;
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  const barColor = color || 'var(--accent)';
  return (
    <div className="plan-progress" onClick={(e) => e.stopPropagation()}>
      <button
        className="plan-progress-head"
        onClick={() => setOpen((o) => !o)}
        title={plan.title || 'PLAN.md'}
      >
        <span className="plan-progress-caret">{open ? '▾' : '▸'}</span>
        <span className="plan-progress-label">PLAN</span>
        <div className="plan-progress-bar">
          <div className="plan-progress-fill" style={{ width: `${pct}%`, background: barColor }}/>
        </div>
        <span className="plan-progress-count tnum">{plan.done}/{plan.total}</span>
      </button>
      {open && (
        <ul className="plan-items">
          {plan.items.map((it, i) => (
            <li key={i} className={`plan-item ${it.done ? 'done' : ''}`}>
              <span className="plan-item-box">{it.done ? '✓' : '○'}</span>
              <span className="plan-item-text">{it.text || <span style={{ color: 'var(--text-4)' }}>(empty)</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sessionStatusKind(s) {
  if (!s?.alive) return 'dead';
  if (s.status === 'busy') return 'busy';
  if (s.status === 'waiting') return 'waiting';
  return 'idle';
}

function HarnessIcon({ harness }) {
  const h = harness || 'claudecode';
  const cls = h === 'opencode' ? 'opencode' : h === 'claudecode' ? 'claudecode' : 'other';
  const icon = window.ModelProviders?.harnessForId?.(h);
  return (
    <span className={`agent-harness-icon ${cls}`} role="img" title={`harness: ${icon?.label || h}`} aria-label={`harness ${icon?.label || h}`}>
      {icon?.iconSrc ? <img src={icon.iconSrc} alt=""/> : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
      )}
    </span>
  );
}

function ModelPill({ model }) {
  if (!model) return null;
  const provider = window.ModelProviders?.providerForModel?.(model);
  return (
    <span className="agent-model-pill" title={provider ? `${provider.label}: ${model}` : model}>
      {provider?.iconSrc && <span className={`agent-model-icon provider-${provider.id}`} aria-hidden="true"><img src={provider.iconSrc} alt=""/></span>}<span>{model}</span>
    </span>
  );
}

function AgentCard({ session, name, queueCount = 0, setRoute, showControls = false, compact = false }) {
  const s = session || {};
  const [roleToast, setRoleToast] = React.useState(null);
  const project = window.Store.getProjectByContractId(s.project_id);
  const channel = window.Store.getChannelForSession(s.session_id);
  const hasChannel = !!channel;
  const registered = s.registered || !!project;
  const statusKind = sessionStatusKind(s);
  const working = statusKind === 'busy' || statusKind === 'waiting';
  const statusLabel = statusKind === 'busy' ? 'Working'
    : statusKind === 'waiting' ? 'Waiting'
    : statusKind === 'idle' ? 'Idle'
    : 'Dead';
  const title = name || s.name || (s.session_id ? s.session_id.slice(0, 8) : `pid ${s.pid}`);
  const currentTicket = s.current_in_progress_ticket;
  const pendingCount = Number(s.pending_count || queueCount || 0);
  const unackedWarnings = s.active_unacked_dispatches || [];
  const needsRevival = pendingCount > 0 && (statusKind === 'dead' || !hasChannel);
  const projectLabel = project?.name || s.project_id || 'unregistered project';
  const fallbackProject = project || { glyph: '?', color: 'var(--text-3)' };
  const lastSeen = window.Store.getSessionLastSeen?.(s) || 0;

  const openPeek = () => {
    if (s.session_id) window.openNativeSessionDrawer(s.session_id);
  };
  const openProject = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (project && setRoute) setRoute({ kind: 'project', id: project.id, tab: 'agents' });
  };
  const flashRoleError = (err) => {
    const msg = err?.payload?.error || err?.message || 'Role assignment failed';
    console.error('set role failed', err);
    setRoleToast({ msg: `Role assignment failed: ${msg}`, id: Math.random() });
    setTimeout(() => setRoleToast(null), 3000);
  };

  return (
    <div
      className={`agent-card native-session-card ${working ? 'busy' : 'idle'} status-${statusKind} ${compact ? 'compact' : ''} cc-clickable`}
      data-focus-key={s.session_id ? `agent:${s.session_id}` : undefined}
      onClick={openPeek}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeek(); } }}
      title="open session details"
    >
      <div className="agent-card-head">
        <ProjectGlyph project={fallbackProject} size={compact ? 28 : 34}/>
        <div className="agent-card-titleblock">
          <div className="agent-card-name-row">
            <span className="native-session-name agent-card-name" title={s.name || title}>{title}</span>
            <HarnessIcon harness={s.harness}/>
          </div>
          <button
            className={`agent-project-link ${project ? '' : 'unregistered'}`}
            onClick={openProject}
            disabled={!project || !setRoute}
            title={project ? `open ${project.name}` : (s.project_id || 'unregistered project')}
          >
            {projectLabel}
          </button>
        </div>
        <span className={`cc-status-badge badge-${statusKind} agent-status-badge`}>
          {statusKind === 'busy' && <span className="cc-status-pulse"/>}
          {statusLabel}
        </span>
      </div>

      <div className="agent-card-chips">
        {s.role && <span className="native-session-role-chip">{s.role}</span>}
        <ModelPill model={s.model}/>
        {pendingCount > 0 && <span className="native-session-queue-chip" title={`${pendingCount} queued dispatch${pendingCount === 1 ? '' : 'es'}`}>queued {pendingCount}</span>}
        {needsRevival && <span className="native-session-queue-chip" title="queued dispatches are held for an offline or channel-less session">revival needed</span>}
        {!registered && <span className="native-session-badge">unregistered</span>}
        {unackedWarnings.map((w) => window.UnackedDispatchBadge ? <window.UnackedDispatchBadge key={w.envelope_id || w.delivery_event_id || w.warning_event_id} warning={w} compact/> : null)}
      </div>

      {statusKind === 'waiting' && s.waiting_for && (
        <div className="cc-session-waiting" title="what this session is stuck on">
          <Icon.Clock size={12}/><span>{s.waiting_for}</span>
        </div>
      )}

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

      <div className="native-session-role agent-card-role" onClick={(e) => e.stopPropagation()}>
        <label>
          Role{' '}
          <RoleSelect
            value={s.role || ''}
            onChange={(role) => window.SubstrateAPI.setSessionRole(s.session_id, role).catch(flashRoleError)}
            disabled={!s.session_id}
          />
        </label>
        {lastSeen > 0 && <span className="agent-card-seen mono" title="last seen">seen {window.SubstrateFmt?.fmtTimeAgo?.(lastSeen) || ''}</span>}
        {roleToast && <div className="orch-toast err cc-toast" key={roleToast.id}>{roleToast.msg}</div>}
      </div>

      {!showControls && s.reachable === false && s.alive && (
        <div className="native-session-nochannel" title="live session with no golem channel registered — dispatches can queue, but briefs/interrupts cannot be delivered now">
          <span className="cc-nochannel-dot"/>no channel — dispatches queue until reachable
        </div>
      )}

      {showControls && (hasChannel ? (
        <SessionControls session={s} channel={channel}/>
      ) : (
        s.alive && (
          <div className="cc-session-nochannel" onClick={(e) => e.stopPropagation()} title="no golem channel registered for this session — briefs/interrupts cannot be delivered">
            <span className="cc-nochannel-dot"/>
            {window.Store.getChannels().length > 0
              ? 'no channel (pre-v4 session) — restart to enable controls'
              : 'no channel — controls unavailable'}
          </div>
        )
      ))}
    </div>
  );
}

function SessionControls({ session: s, channel }) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const sid = s.session_id;

  const flash = (msg, kind = 'ok') => {
    setToast({ msg, kind, id: Math.random() });
    setTimeout(() => setToast(null), 2600);
  };
  const run = React.useCallback(async (fn, label) => {
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
  const sendBrief = React.useCallback(async () => {
    const t = text.trim();
    if (!t || busy) return;
    const ok = await run(() => window.SubstrateAPI.pushBrief(t, sid), 'Brief');
    if (ok) setText('');
  }, [text, busy, sid, run]);

  return (
    <div className="cc-session-controls" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="cc-composer">
        <input
          className="cc-composer-input"
          placeholder="Send a brief to this session..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendBrief(); } }}
          disabled={busy}
        />
        <button className="orch-btn primary small" disabled={busy || !text.trim()} onClick={sendBrief}>Send</button>
      </div>
      <div className="cc-session-buttons">
        <button className="orch-btn small" disabled={busy} onClick={() => run(() => window.SubstrateAPI.pushInterrupt(text.trim() || 'interrupt from dashboard', sid), 'Interrupt')}>Interrupt</button>
        <button className="orch-btn small ghost" disabled={busy} onClick={() => { if (confirm(`Halt session ${(sid || '').slice(0, 8)} — gracefully yield after current dispatch?`)) run(() => window.SubstrateAPI.pushHalt('Halt requested from dashboard', sid), 'Halt'); }}>Halt</button>
        <span className="cc-channel-tag mono" title={`channel ${channel.url || `${channel.host}:${channel.port}`}`}>:{channel.port}</span>
      </div>
      {toast && <div className={`orch-toast ${toast.kind} cc-toast`} key={toast.id}>{toast.msg}</div>}
    </div>
  );
}

// Hook for components to subscribe to store changes and re-render.
function useStore() {
  const [, force] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    return window.Store.subscribe(() => force());
  }, []);
  return window.Store;
}

window.Avatar = Avatar;
window.ProjectGlyph = ProjectGlyph;
window.Carousel = Carousel;
window.CarouselControls = CarouselControls;
window.ConnectionPill = ConnectionPill;
window.PlanProgress = PlanProgress;
window.AgentCard = AgentCard;
window.SessionControls = SessionControls;
window.useStore = useStore;
