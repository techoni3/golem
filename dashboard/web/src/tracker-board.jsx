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

  const cols = showArchived ? [...TRACKER_COLUMNS, TRACKER_ARCHIVED_COL] : TRACKER_COLUMNS;
  const allProjects = !projectFilter;

  const onNewTicket = () => {
    window.dispatchEvent(new CustomEvent('open-create-ticket', {
      detail: { project_id: projectFilter || null },
    }));
  };

  const resolveAssignee = (a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  };

  return (
    <div className="page tracker-board">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tracker</h1>
          <div className="page-subtitle">
            {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
            {allProjects ? ' across all projects' : ''}
          </div>
        </div>
        <div className="tracker-toolbar">
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
        tickets={tickets}
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
function TicketColumns({ cols, tickets, projectByContract, resolveAssignee }) {
  const resolve = resolveAssignee || ((a) => (a === 'human' ? 'You' : !a ? 'Unassigned' : `session ${String(a).slice(0, 8)}`));
  return (
    <div className="kanban tracker-kanban" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))` }}>
      {cols.map((c) => {
        const colTickets = tickets.filter((t) => t.state === c.id);
        return (
          <div key={c.id} className="kanban-col">
            <div className="kanban-col-header">
              <div className="kanban-col-title">
                <span className="dot" style={{ background: c.color }}/>
                {c.label}
              </div>
              <div className="kanban-col-count tnum">{colTickets.length}</div>
            </div>
            <div className="kanban-list">
              {colTickets.length === 0 && <div className="empty">empty</div>}
              {colTickets.map((t) => (
                <TrackerCard
                  key={t.id}
                  ticket={t}
                  project={projectByContract ? projectByContract.get(t.project_id) : null}
                  assigneeLabel={resolve(t.assignee)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrackerCard({ ticket: t, project, assigneeLabel }) {
  const open = () => {
    window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: t.id } }));
  };
  const prio = t.priority ? String(t.priority).toLowerCase() : null;
  const needsAnswer = isQuestionForHuman(t);
  return (
    <div className={`ticket cc-clickable ${needsAnswer ? 'ticket-needs-answer' : ''}`} data-ticket-id={t.id} onClick={open} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>
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
