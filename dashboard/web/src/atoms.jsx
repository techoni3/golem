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

function StatusPill({ status }) {
  const map = {
    active: { cls: 'active', label: 'Active' },
    running: { cls: 'running', label: 'Running' },
    review: { cls: 'review', label: 'In Review' },
    blocked: { cls: 'blocked', label: 'Blocked' },
    done: { cls: 'done', label: 'Done' },
    idle: { cls: 'idle', label: 'Idle' },
  };
  const m = map[status] || map.idle;
  return (
    <span className={`pill ${m.cls}`}>
      <span className="dot"/>
      {m.label}
    </span>
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
window.StatusPill = StatusPill;
window.Carousel = Carousel;
window.CarouselControls = CarouselControls;
window.ConnectionPill = ConnectionPill;
window.PlanProgress = PlanProgress;
window.useStore = useStore;
