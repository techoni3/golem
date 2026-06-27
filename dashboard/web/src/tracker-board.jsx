// Tracker board (WS5a) — the consolidated cross-project kanban over the
// tracker.db tickets (Store.getTrackerTickets), distinct from the legacy
// per-project markdown Kanban in project-view.jsx.
//
// Header: project / kind / assignee filters + "Show archived" toggle +
// "+ New ticket" (fires `open-create-ticket`). Board: state columns reusing
// the .kanban / .ticket markup. Cards fire `open-ticket-drawer` on click
// (the drawer itself is WS5b — wiring the event now is correct).

// State columns in board order. `archived` is appended only when the toggle
// is on. Each maps to a --status-* color var (see styles.css tokens).
const TRACKER_COLUMNS = [
  { id: 'todo', label: 'Todo', color: 'var(--status-open)' },
  { id: 'in_progress', label: 'In Progress', color: 'var(--status-running)' },
  { id: 'blocked', label: 'Blocked', color: 'var(--status-blocked)' },
  { id: 'review', label: 'Review', color: 'var(--status-review)' },
  { id: 'done', label: 'Done', color: 'var(--status-done)' },
];
const TRACKER_ARCHIVED_COL = { id: 'archived', label: 'Archived', color: 'var(--status-done)' };

const TRACKER_KINDS = ['work-item', 'decision', 'spec', 'question', 'fix'];

// TKT-0103: drag-and-drop. The dashboard loads @dnd-kit/core via an ES module
// in index.html that registers window.__dndkit (and signals __dndkitReady).
// Babel-standalone transforms ESM `import` → `require`, which fails in the
// browser — so we read the global instead. A small hook waits for the ESM
// script to finish before any DnD hook fires (first render shows a fallback).
function useDndKit() {
  const [ready, setReady] = React.useState(!!(typeof window !== 'undefined' && window.__dndkitReady));
  React.useEffect(() => {
    if (ready) return;
    if (typeof window !== 'undefined' && window.__dndkitReady) { setReady(true); return; }
    const onReady = () => setReady(true);
    window.addEventListener('dndkit-ready', onReady);
    return () => window.removeEventListener('dndkit-ready', onReady);
  }, [ready]);
  return ready && typeof window !== 'undefined' ? window.__dndkit : null;
}

// WS6: a question FOR the user — a question-kind ticket assigned to 'human' that
// isn't done/archived. Surfaced with a "needs answer" accent on cards + in the
// drawer, and matched by the board's "Needs my answer" quick filter.
function isQuestionForHuman(t) {
  return !!t
    && t.kind === 'question'
    && t.assignee === 'human'
    && t.state !== 'done'
    && t.state !== 'archived';
}

function TrackerBoard() {
  useStore();
  const projects = window.Store.getProjects();

  const [projectFilter, setProjectFilter] = React.useState('');   // '' = all, else project_id
  const [kindFilter, setKindFilter] = React.useState('');         // '' = all
  const [assigneeFilter, setAssigneeFilter] = React.useState(''); // '' all | human | __unassigned__
  const [showArchived, setShowArchived] = React.useState(false);
  const [needsAnswer, setNeedsAnswer] = React.useState(false);    // WS6 quick filter
  // TKT-0104: client-side search. Debounced 80ms to avoid jank on fast typing.
  // Matches against id, title, kind, priority, assignee label, project name
  // (cross-project view only). Body text intentionally NOT matched (would
  // require fetching every ticket's full body).
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim().toLowerCase()), 80);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Build a label resolver for assignees from the dispatchable sessions of the
  // currently-selected project (so session_id → friendly label where known).
  const [dispatchable, setDispatchable] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    window.SubstrateAPI
      .listDispatchable(projectFilter || null)
      .then((list) => { if (!cancelled) setDispatchable(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    return () => { cancelled = true; };
  }, [projectFilter]);

  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);

  // "Needs my answer" is a self-contained quick filter: it forces
  // kind=question + assignee=human + state∉{done,archived}, overriding the
  // kind/assignee/archived controls while engaged.
  const filter = needsAnswer
    ? {
      project_id: projectFilter || undefined,
      kind: 'question',
      assignee: 'human',
      includeArchived: false,
    }
    : {
      project_id: projectFilter || undefined,
      kind: kindFilter || undefined,
      assignee:
        assigneeFilter === 'human' ? 'human'
          : assigneeFilter === '__unassigned__' ? '__unassigned__'
            : undefined,
      includeArchived: showArchived,
    };
  const tickets = window.Store.getTrackerTickets(filter);

  const projectByContract = React.useMemo(() => {
    const m = new Map();
    for (const p of projects) if (p.project_id) m.set(p.project_id, p);
    return m;
  }, [projects]);

  const resolveAssignee = (a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  };

  // TKT-0104: client-side search. When the debounced searchQuery is non-empty
  // we further filter the server-filtered tickets on id/title/kind/priority/
  // assignee-label/project-name. Empty query = no client filter.
  const visibleTickets = React.useMemo(() => {
    if (!searchQuery) return tickets;
    const q = searchQuery;
    return tickets.filter((t) => {
      if ((t.id || '').toLowerCase().includes(q)) return true;
      if ((t.title || '').toLowerCase().includes(q)) return true;
      if ((t.kind || '').toLowerCase() === q) return true;
      if ((t.priority || '').toLowerCase() === q) return true;
      const aLabel = resolveAssignee(t.assignee).toLowerCase();
      if (aLabel.includes(q)) return true;
      const p = projectByContract.get(t.project_id);
      if (p && p.name && p.name.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [tickets, searchQuery, projectByContract]);

  const cols = showArchived ? [...TRACKER_COLUMNS, TRACKER_ARCHIVED_COL] : TRACKER_COLUMNS;
  const allProjects = !projectFilter;

  const onNewTicket = () => {
    window.dispatchEvent(new CustomEvent('open-create-ticket', {
      detail: { project_id: projectFilter || null },
    }));
  };

  return (
    <div className="page tracker-board">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tracker</h1>
          <div className="page-subtitle">
            {visibleTickets.length} ticket{visibleTickets.length === 1 ? '' : 's'}
            {searchQuery && tickets.length !== visibleTickets.length ? ` (of ${tickets.length})` : ''}
            {allProjects ? ' across all projects' : ''}
          </div>
        </div>
        <div className="tracker-toolbar">
          {/* TKT-0104: client-side search across id/title/kind/priority/assignee/project */}
          <input
            type="search"
            className="tracker-search"
            placeholder="Search id / title / kind / assignee / project"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search tickets"
          />
          <select className="tracker-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} title="Project">
            <option value="">All projects</option>
            {projects.filter((p) => p.project_id).map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.name}</option>
            ))}
          </select>
          <select className="tracker-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} title="Kind">
            <option value="">All kinds</option>
            {TRACKER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select className="tracker-select" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} title="Assignee" disabled={needsAnswer}>
            <option value="">All assignees</option>
            <option value="human">Human</option>
            <option value="__unassigned__">Unassigned</option>
          </select>
          <label className={`tracker-toggle tracker-needs-answer ${needsAnswer ? 'on' : ''}`} title="Show only questions assigned to you that need an answer">
            <input type="checkbox" checked={needsAnswer} onChange={(e) => setNeedsAnswer(e.target.checked)}/>
            ❓ Needs my answer
          </label>
          <label className="tracker-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} disabled={needsAnswer}/>
            Show archived
          </label>
          <button className="orch-btn primary" onClick={onNewTicket}>+ New ticket</button>
        </div>
      </div>

      <TicketColumns
        cols={cols}
        tickets={visibleTickets}
        projectByContract={allProjects ? projectByContract : null}
        resolveAssignee={resolveAssignee}
      />
    </div>
  );
}

// Shared column renderer — used by the consolidated board (TrackerBoard) and
// the per-project board (project-view.jsx). `projectByContract` is a Map only
// when cards should show a project chip (cross-project view); pass null to hide
// it (single-project view). `cols` lets callers vary the column set.
//
// TKT-0103: wraps the board in <DndContext> with PointerSensor (mouse + touch)
// + KeyboardSensor (Space to lift, ArrowUp/Down to move, Space to drop —
// WAI-ARIA). On drag end: if dropped in a different column, PATCH state;
// same-column reorder is optimistic for now (Phase C will persist via the
// `move` endpoint that writes rank).
function TicketColumns({ cols, tickets, projectByContract, resolveAssignee }) {
  const resolve = resolveAssignee || ((a) => (a === 'human' ? 'You' : !a ? 'Unassigned' : `session ${String(a).slice(0, 8)}`));
  const dnd = useDndKit();
  // Hooks must be called unconditionally; pull from the dndkit global when
  // ready, otherwise fall through to no-op stubs (the render still works).
  const DndContext = (dnd && dnd.DndContext) || NoopDndContext;
  const DragOverlay = (dnd && dnd.DragOverlay) || NoopDragOverlay;
  const closestCenter = (dnd && dnd.closestCenter) || (() => []);
  const useSensors = dnd ? dnd.useSensors : () => [];
  const useSensor = dnd ? dnd.useSensor : () => null;
  const PointerSensor = dnd && dnd.PointerSensor;
  const KeyboardSensor = dnd && dnd.KeyboardSensor;
  const sensors = useSensors(
    PointerSensor ? useSensor(PointerSensor, { activationConstraint: { distance: 6 } }) : null,
    KeyboardSensor ? useSensor(KeyboardSensor) : null,
  );
  // Optimistic in-memory overrides: { [ticketId]: newState } applied on top of
  // the store tickets so the card visually jumps to the new column while the
  // PATCH is in flight. Cleared on the next snapshot update.
  const [overrides, setOverrides] = React.useState({});
  const [activeId, setActiveId] = React.useState(null);
  const activeTicket = React.useMemo(() => {
    if (!activeId) return null;
    return tickets.find((t) => t.id === activeId) || null;
  }, [activeId, tickets]);

  const onDragStart = (e) => setActiveId(e.active.id);
  const onDragEnd = (e) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const ticketId = String(active.id);
    const overCol = String(over.id); // droppable id == column id
    const t = tickets.find((x) => x.id === ticketId);
    if (!t || t.state === overCol) return;
    // Optimistic move
    setOverrides((cur) => ({ ...cur, [ticketId]: overCol }));
    window.SubstrateAPI.updateTicket(ticketId, { state: overCol, actor: 'human' })
      .then((updated) => {
        if (updated && updated.id) {
          window.Store.upsertTrackerTicket(updated);
          setOverrides((cur) => {
            const next = { ...cur };
            delete next[ticketId];
            return next;
          });
        }
      })
      .catch((err) => {
        console.error('move failed', err);
        // Roll back the optimistic update on failure.
        setOverrides((cur) => {
          const next = { ...cur };
          delete next[ticketId];
          return next;
        });
      });
  };

  // Apply overrides to derive the visible tickets.
  const visibleTickets = React.useMemo(() => {
    if (!Object.keys(overrides).length) return tickets;
    return tickets.map((t) => overrides[t.id] ? { ...t, state: overrides[t.id] } : t);
  }, [tickets, overrides]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter}
      onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="kanban tracker-kanban" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))` }}>
        {cols.map((c) => {
          const colTickets = visibleTickets.filter((t) => t.state === c.id);
          return (
            <ColumnDrop key={c.id} id={c.id} label={c.label} color={c.color} count={colTickets.length}>
              {colTickets.length === 0 && <div className="empty">empty</div>}
              {colTickets.map((t) => (
                <TrackerCard
                  key={t.id}
                  ticket={t}
                  project={projectByContract ? projectByContract.get(t.project_id) : null}
                  assigneeLabel={resolve(t.assignee)}
                />
              ))}
            </ColumnDrop>
          );
        })}
      </div>
      <DragOverlay>
        {activeTicket ? (
          <div className="ticket ticket-drag-overlay">
            <div className="tracker-card-tags">
              <span className="pill tracker-kind-pill">{activeTicket.kind}</span>
            </div>
            <div className="ticket-id">{activeTicket.id}</div>
            <div className="ticket-title">{activeTicket.title}</div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// Each column is a droppable target. Wrapping it in its own component lets
// @dnd-kit's hook subscribe to a stable id without re-rendering the whole grid.
function ColumnDrop({ id, label, color, count, children }) {
  const dnd = useDndKit();
  // Always call the hook (React rules), but pass a noop when dnd isn't loaded.
  const useDroppable = dnd ? dnd.useDroppable : NoopUseDroppable;
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`kanban-col ${isOver ? 'is-drop-over' : ''}`} data-col={id}>
      <div className="kanban-col-header">
        <div className="kanban-col-title">
          <span className="dot" style={{ background: color }}/>
          {label}
        </div>
        <div className="kanban-col-count tnum">{count}</div>
      </div>
      <div className="kanban-list">{children}</div>
    </div>
  );
}

// Fallbacks for the brief moment between first render and the ESM module
// finishing load. They let the board render normally; once @dnd-kit is ready,
// re-render swaps in the real hooks.
function NoopDndContext({ children }) { return React.createElement(React.Fragment, null, children); }
function NoopDragOverlay({ children }) { return null; }
function NoopUseDroppable() { return { isOver: false, setNodeRef: (n) => n }; }
function NoopUseDraggable() { return { attributes: {}, listeners: {}, setNodeRef: (n) => n, isDragging: false }; }

function TrackerCard({ ticket: t, project, assigneeLabel }) {
  const open = () => {
    window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: t.id } }));
  };
  const prio = t.priority ? String(t.priority).toLowerCase() : null;
  const needsAnswer = isQuestionForHuman(t);
  // TKT-0103: drag handle. Activation distance (6px, set in TicketColumns's
  // PointerSensor activationConstraint) prevents accidental drags on click.
  // The drag listeners are bound to the card root; a click without a drag
  // still opens the drawer as before. When @dnd-kit is not loaded yet we get
  // a noop hook that returns a plain ref — the card still renders, click
  // still opens the drawer.
  const dnd = useDndKit();
  const useDraggable = dnd ? dnd.useDraggable : NoopUseDraggable;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: t.id,
    data: { kind: t.kind, fromState: t.state },
  });
  return (
    <div
      ref={setNodeRef}
      className={`ticket cc-clickable kind-${t.kind || 'work-item'} state-${t.state} ${needsAnswer ? 'ticket-needs-answer' : ''} ${isDragging ? 'is-dragging' : ''}`}
      data-ticket-id={t.id}
      role="button"
      tabIndex={0}
      onClick={(e) => { if (!isDragging) open(); }}
      onKeyDown={(e) => {
        if (isDragging) return; // KeyboardSensor is handling this card right now
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      }}
      {...attributes}
      {...listeners}
    >
      <div className="tracker-card-tags">
        {project && (
          <span className="cc-chip tracker-project-chip" title={project.name}>
            <span className="cc-chip-dot" style={{ background: project.color }}/>
            <span className="cc-chip-text">{project.glyph ? `${project.glyph} ` : ''}{project.name}</span>
          </span>
        )}
        <span className="pill tracker-kind-pill">{t.kind}</span>
        {needsAnswer && <span className="pill tracker-answer-badge">❓ needs answer</span>}
      </div>
      <div className="ticket-id">{t.id}</div>
      <div className="ticket-title">{t.title}</div>
      <div className="ticket-footer">
        <div className="ticket-assignee">
          <span>{assigneeLabel}</span>
        </div>
        {prio && <span className={`ticket-priority ${prio}`}>{t.priority}</span>}
      </div>
    </div>
  );
}

window.TrackerBoard = TrackerBoard;
window.TrackerCard = TrackerCard;
window.TicketColumns = TicketColumns;
// WS6: shared question-for-human predicate, reused by the ticket drawer to
// decide when to surface the "Answer & return" affordance + header badge.
window.isQuestionForHuman = isQuestionForHuman;
// Exported so the per-project board (project-view.jsx) shares the exact column
// set + ordering, avoiding drift between the two boards.
window.TRACKER_COLUMNS = TRACKER_COLUMNS;
window.TRACKER_ARCHIVED_COL = TRACKER_ARCHIVED_COL;
