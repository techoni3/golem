// TKT-0284 / TKT-0339: Specs board — spec-kind tickets (separation by view,
// not entity). A spec IS a ticket with kind='spec'.
//
// GOL-166: the standalone /specs page is the only top-level specs tracker.
// This view is also mounted in the project view's explicit Specs sub-board
// (projectId=<id> → pinned, no project filter). One component, two mounts — no
// divergent copies. The parent provides the title/context; this renders only a
// toolbar + the board/search.
//
// Reuses tracker-board.jsx's window.TicketColumns + window.TrackerCard so the
// board machinery (drag-to-column, card, gear, staleness) is identical. SPEC
// columns relabel the same states (Draft/Refining/Blocked/Review/Locked).
// Content search renders a flat result list with <mark> snippets while active.

const TicketColumns = window.TicketColumns;

const SPEC_COLUMNS = [
  { id: 'todo', label: 'Draft', color: 'var(--status-open)' },
  { id: 'in_progress', label: 'Refining', color: 'var(--status-running)' },
  { id: 'blocked', label: 'Blocked', color: 'var(--status-blocked)' },
  { id: 'review', label: 'Review', color: 'var(--status-review)' },
  { id: 'done', label: 'Locked', color: 'var(--status-done)' },
];
const SPEC_ARCHIVED_COL = { id: 'archived', label: 'Archived', color: 'var(--status-done)' };

const SPEC_STATE_PILL = {
  todo: 'idle',
  in_progress: 'running',
  blocked: 'blocked',
  review: 'review',
  done: 'done',
  archived: 'done',
};

function specAgo(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return window.SubstrateFmt?.fmtTimeAgo?.(t) || '';
}

function markFirst(text, qLower) {
  const s = String(text || '');
  if (!qLower) return s;
  const idx = s.toLowerCase().indexOf(qLower);
  if (idx < 0) return s;
  return [s.slice(0, idx), <mark key="m">{s.slice(idx, idx + qLower.length)}</mark>, s.slice(idx + qLower.length)];
}

function markSnippet(snippet, matchStart, matchLen) {
  const s = String(snippet || '');
  if (matchStart < 0 || !matchLen) return s;
  return [s.slice(0, matchStart), <mark key="m">{s.slice(matchStart, matchStart + matchLen)}</mark>, s.slice(matchStart + matchLen)];
}

// TKT-0339: reusable specs board view.
//   projectId == null → renders its own project filter (Tracker Specs mode).
//   projectId set     → pinned to that project, no project filter (project view);
//                       + New spec presets the project.
function SpecsBoardView({ projectId = null }) {
  useStore();
  const projects = window.Store.getProjects();
  const pinned = projectId != null;

  const [projectFilter, setProjectFilter] = React.useState('');
  // The effective project: pinned wins, else the user's filter selection.
  const effectiveProject = pinned ? projectId : projectFilter;

  const [showArchived, setShowArchived] = React.useState(false);
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [dispatchable, setDispatchable] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    window.SubstrateAPI
      .listDispatchable(effectiveProject || null)
      .then((list) => { if (!cancelled) setDispatchable(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    return () => { cancelled = true; };
  }, [effectiveProject]);
  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);
  const resolveAssignee = (a) => {
    if (a === 'human' || a === 'you' || a === 'human:dashboard') return 'Lavee';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || window.Store?.getNativeSessionById?.(a)?.name || window.Store?.getNativeSessionById?.(a)?.label || `session ${String(a).slice(0, 8)}`;
  };

  const filter = {
    project_id: effectiveProject || undefined,
    kind: 'spec',
    includeArchived: showArchived,
  };
  const tickets = window.Store.getTrackerTickets(filter);

  const projectByContract = React.useMemo(() => {
    const m = new Map();
    for (const p of projects) if (p.project_id) m.set(p.project_id, p);
    return m;
  }, [projects]);

  const [searchResults, setSearchResults] = React.useState(null);
  const [searching, setSearching] = React.useState(false);
  React.useEffect(() => {
    const q = searchQuery;
    if (q.length < 2) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    let cancelled = false;
    window.SubstrateAPI.searchTickets({ project: effectiveProject || undefined, kind: 'spec', q })
      .then((rows) => { if (!cancelled) { setSearchResults(Array.isArray(rows) ? rows : []); setSearching(false); } })
      .catch(() => { if (!cancelled) { setSearchResults([]); setSearching(false); } });
    return () => { cancelled = true; };
  }, [searchQuery, effectiveProject]);
  const inSearchMode = searchResults !== null;
  const qLower = searchQuery.toLowerCase();

  const cols = showArchived ? [...SPEC_COLUMNS, SPEC_ARCHIVED_COL] : SPEC_COLUMNS;
  const allProjects = !effectiveProject;

  const onNewSpec = () => {
    window.Router.openComposer(effectiveProject || null, { kind: 'spec' });
  };

  return (
    <div className="specs-board">
      <div className="specs-toolbar tracker-toolbar">
        <input
          type="search"
          className="tracker-search"
          placeholder="Search specs — title & content"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setSearchInput(''); } }}
          aria-label="Search specs by title or content"
        />
        {!pinned && (
          <select className="tracker-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} title="Project">
            <option value="">All projects</option>
            {projects.filter((p) => p.project_id).map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.name}</option>
            ))}
          </select>
        )}
        <span className="specs-count tnum">
          {inSearchMode
            ? `${searchResults.length} match${searchResults.length === 1 ? '' : 's'}`
            : `${tickets.length} spec${tickets.length === 1 ? '' : 's'}${allProjects ? ' · all projects' : ''}`}
        </span>
        <label className="tracker-toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}/>
          Show archived
        </label>
        <button className="orch-btn primary" onClick={onNewSpec}>+ New spec</button>
      </div>

      {inSearchMode ? (
        <SpecSearchResults results={searchResults} qLower={qLower} searching={searching}/>
      ) : (
        <TicketColumns
          cols={cols}
          tickets={tickets}
          projectByContract={allProjects ? projectByContract : null}
          resolveAssignee={resolveAssignee}
        />
      )}
    </div>
  );
}

// TKT-0284: flat search-result list (replaces the board while a query is
// active). Each row: id · state pill · updated-ago · title (with <mark> on the
// title match) · snippet (with <mark> on the body match, using the server's
// offsets). Click → the same drawer the board uses.
function SpecSearchResults({ results, qLower, searching }) {
  if (searching && (!results || results.length === 0)) {
    return <div className="specs-search-empty">Searching…</div>;
  }
  if (!results || results.length === 0) {
    return <div className="specs-search-empty">No specs match.</div>;
  }
  return (
    <div className="specs-search-list">
      {results.map((r) => (
        <a key={r.id}
          className="spec-result-row"
          href={window.Router.buildHref({ kind: 'ticket', id: r.id })}
          onClick={(e) => { e.preventDefault(); window.Router.openTicket(r.id); }}
        >
          <div className="spec-result-head">
            <span className="spec-result-id mono">{r.display_id || r.id}</span>
            <span className={`pill ${SPEC_STATE_PILL[r.state] || 'idle'}`}>{r.state}</span>
            <span className="spec-result-ago">{specAgo(r.updated_at)}</span>
          </div>
          <div className="spec-result-title">{markFirst(r.title, qLower)}</div>
          {r.snippet && (
            <div className="spec-result-snippet">{markSnippet(r.snippet, r.match_start, r.match_len)}</div>
          )}
        </a>
      ))}
    </div>
  );
}

window.SpecsBoardView = SpecsBoardView;
window.SPEC_COLUMNS = SPEC_COLUMNS;
window.SPEC_ARCHIVED_COL = SPEC_ARCHIVED_COL;

function SpecsPage() {
  return (
    <div className="page specs-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Specs</h1>
          <div className="page-subtitle">Spec tracker</div>
        </div>
      </div>
      <SpecsBoardView />
    </div>
  );
}

window.SpecsPage = SpecsPage;
