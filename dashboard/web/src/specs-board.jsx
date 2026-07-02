// TKT-0284: Specs page — spec-kind tickets separated by view, not entity.
//
// A spec IS a ticket with kind='spec' (same core, same drawer, same agents,
// same MCP). Separation happens here at the view layer: the Specs board is
// the Tracker board with (a) spec-only data (kind=spec), (b) doc-lifecycle
// column labels (Draft/Refining/Blocked/Review/Locked over the same states),
// and (c) content search across title + body (specs are "far fewer" but
// dense — a filtered board can't show where in the doc a hit landed, so
// search renders a flat result list with highlighted snippets while active).
//
// Reuses tracker-board.jsx's window.TicketColumns + window.TrackerCard so the
// board machinery (drag-to-column, card, gear, staleness) is identical — no
// forked copies. The Tracker excludes specs (filter.exclude_kind='spec'), so
// a spec-kind ticket appears ONLY here, never on the Tracker. Work items
// that emerge from a spec are ordinary work-item tickets with parent_id =
// <spec id>; the spec drawer renders them (SpecChildrenPanel, ticket-drawer.jsx).

const TicketColumns = window.TicketColumns;

// Spec board columns — doc-lifecycle labels over the SAME underlying states
// (PATCHes still carry todo/in_progress/...). Agents + MCP keep seeing the
// raw states; only this board relabels. Colors mirror the tracker's column
// palette so a card's state reads consistently across both boards.
// (Judgment call #1 — display-only, cheap to flip.)
const SPEC_COLUMNS = [
  { id: 'todo', label: 'Draft', color: 'var(--status-open)' },
  { id: 'in_progress', label: 'Refining', color: 'var(--status-running)' },
  { id: 'blocked', label: 'Blocked', color: 'var(--status-blocked)' },
  { id: 'review', label: 'Review', color: 'var(--status-review)' },
  { id: 'done', label: 'Locked', color: 'var(--status-done)' },
];
const SPEC_ARCHIVED_COL = { id: 'archived', label: 'Archived', color: 'var(--status-done)' };

// State → .pill modifier for search-result rows (mirrors TD_STATE_PILL).
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

// Wrap the first case-insensitive occurrence of `qLower` (already lowercased)
// in a <mark>. Returns an array of text + the mark (React renders arrays).
function markFirst(text, qLower) {
  const s = String(text || '');
  if (!qLower) return s;
  const idx = s.toLowerCase().indexOf(qLower);
  if (idx < 0) return s;
  return [s.slice(0, idx), <mark key="m">{s.slice(idx, idx + qLower.length)}</mark>, s.slice(idx + qLower.length)];
}

// Body snippet <mark> using the SERVER's offsets (match_start / match_len are
// offsets within the returned snippet, accounting for the leading '…' — so
// client-side re-matching the token could be off if the snippet's ellipsis
// shifted the index). -1 / 0 match_len = no body match → render plain.
function markSnippet(snippet, matchStart, matchLen) {
  const s = String(snippet || '');
  if (matchStart < 0 || !matchLen) return s;
  return [s.slice(0, matchStart), <mark key="m">{s.slice(matchStart, matchStart + matchLen)}</mark>, s.slice(matchStart + matchLen)];
}

function SpecsBoard() {
  useStore();
  const projects = window.Store.getProjects();

  const [projectFilter, setProjectFilter] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  // 250ms debounce (≥2 chars enforced server-side). Specs are dense; a faster
  // debounce would fire a body-search round-trip per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // resolveAssignee: build a session_id → friendly-label map from the
  // dispatchable sessions of the selected project (mirrors the tracker so a
  // spec card shows the same assignee label it would on the tracker).
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
  const resolveAssignee = (a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  };

  // Board tickets: spec-kind only (+ project + archived). The store filters
  // client-side; the server snapshot already carries every ticket.
  const filter = {
    project_id: projectFilter || undefined,
    kind: 'spec',
    includeArchived: showArchived,
  };
  const tickets = window.Store.getTrackerTickets(filter);

  const projectByContract = React.useMemo(() => {
    const m = new Map();
    for (const p of projects) if (p.project_id) m.set(p.project_id, p);
    return m;
  }, [projects]);

  // Search mode (content search across title + body — server-side LIKE).
  // Active when the debounced query is ≥2 chars; renders a flat result list
  // with highlighted snippets INSTEAD of the board. null = inactive; [] =
  // searched + empty. Re-runs on projectFilter change (scope the search).
  // (Judgment call #2 — display-only, cheap to flip.)
  const [searchResults, setSearchResults] = React.useState(null);
  const [searching, setSearching] = React.useState(false);
  React.useEffect(() => {
    const q = searchQuery;
    if (q.length < 2) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    let cancelled = false;
    window.SubstrateAPI.searchTickets({ project: projectFilter || undefined, kind: 'spec', q })
      .then((rows) => { if (!cancelled) { setSearchResults(Array.isArray(rows) ? rows : []); setSearching(false); } })
      .catch(() => { if (!cancelled) { setSearchResults([]); setSearching(false); } });
    return () => { cancelled = true; };
  }, [searchQuery, projectFilter]);
  const inSearchMode = searchResults !== null;
  const qLower = searchQuery.toLowerCase();

  const cols = showArchived ? [...SPEC_COLUMNS, SPEC_ARCHIVED_COL] : SPEC_COLUMNS;
  const allProjects = !projectFilter;

  const onNewSpec = () => {
    window.Router.openComposer(projectFilter || null, { kind: 'spec' });
  };

  return (
    <div className="page specs-board">
      <div className="page-header">
        <div>
          <h1 className="page-title">Specs</h1>
          <div className="page-subtitle">
            {inSearchMode
              ? `${searchResults.length} match${searchResults.length === 1 ? '' : 's'} for "${searchQuery}"`
              : `${tickets.length} spec${tickets.length === 1 ? '' : 's'}${allProjects ? ' across all projects' : ''}`}
          </div>
        </div>
        <div className="tracker-toolbar">
          <input
            type="search"
            className="tracker-search"
            placeholder="Search specs — title & content"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setSearchInput(''); } }}
            aria-label="Search specs by title or content"
          />
          <select className="tracker-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} title="Project">
            <option value="">All projects</option>
            {projects.filter((p) => p.project_id).map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.name}</option>
            ))}
          </select>
          <label className="tracker-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}/>
            Show archived
          </label>
          <button className="orch-btn primary" onClick={onNewSpec}>+ New spec</button>
        </div>
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
// active). Each row: id · state pill · updated-ago · title (with <mark> on
// the title match) · snippet (with <mark> on the body match, using the
// server's offsets). Click → the same drawer the board uses.
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
            <span className="spec-result-id mono">{r.id}</span>
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

window.SpecsBoard = SpecsBoard;
window.SPEC_COLUMNS = SPEC_COLUMNS;
window.SPEC_ARCHIVED_COL = SPEC_ARCHIVED_COL;