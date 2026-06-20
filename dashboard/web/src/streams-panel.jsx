// Work-streams panel (WS6) — renders a project's streams, each grouping its
// member tickets into sequential or parallel work. Mounted inside project-view
// as a "Streams" section above the per-project tracker board.
//
// A stream is `{id, project_id, name, mode:'sequential'|'parallel', description,
// created_at, updated_at}`. Member tickets are the project's tracker tickets
// whose `stream_id === stream.id`. For `sequential` streams members are ordered
// by `seq` (the monotonic ticket-allocation counter) and the first non-done /
// non-archived ticket is flagged "▶ next"; for `parallel` they read as an
// unordered set. Cards fire `open-ticket-drawer` identically to the board, so
// the drawer opens with no extra wiring.
//
// "+ New stream" reveals an inline form (name / mode / description) →
// createStream(); the new stream lands via the `stream-updated` WS delta (the
// store upserts into state.streams), so no optimistic insert is needed.

const SP_MODES = ['sequential', 'parallel'];
const SP_TERMINAL = new Set(['done', 'archived']);

// Streams panel for one CONTRACT project_id. Reads streams + tickets straight
// from the store (kept live by `stream-updated` / `ticket-*` WS deltas).
function StreamsPanel({ contractId }) {
  useStore();
  const [adding, setAdding] = React.useState(false);

  if (!contractId) return null;

  const streams = window.Store.getStreams(contractId);
  // Tickets with a stream_id, grouped by stream. Archived tickets are excluded
  // (they belong to the archived board column, not a live stream view).
  const tickets = window.Store.getTrackerTickets({ project_id: contractId, includeArchived: false });
  const byStream = React.useMemo(() => {
    const m = new Map();
    for (const t of tickets) {
      if (!t.stream_id) continue;
      const list = m.get(t.stream_id) ?? [];
      list.push(t);
      m.set(t.stream_id, list);
    }
    return m;
  }, [tickets]);

  // Newest-stream-last to match server ordering (created_at ASC).
  const ordered = [...streams].sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')));

  return (
    <div className="pv-section pv-streams">
      <div className="pv-section-head">
        <span className="pv-section-title">Streams</span>
        <span className="pv-section-count tnum">{streams.length}</span>
        <div className="pv-streams-tools">
          <button className="orch-btn small" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : '+ New stream'}
          </button>
        </div>
      </div>

      {adding && (
        <NewStreamForm
          projectId={contractId}
          onDone={() => setAdding(false)}
        />
      )}

      {streams.length === 0 && !adding ? (
        <div className="pv-quiet-line">
          no streams yet — streams group related tickets into <span className="mono">sequential</span> or{' '}
          <span className="mono">parallel</span> work. Click <span className="mono">+ New stream</span> to add one.
        </div>
      ) : (
        <div className="sp-list">
          {ordered.map((s) => (
            <StreamCard
              key={s.id}
              stream={s}
              members={byStream.get(s.id) ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One stream: header (name + mode badge + member count), description, and its
// member tickets. For sequential mode members are seq-ordered and the first
// non-terminal ticket gets the "▶ next" marker + an accent ring.
function StreamCard({ stream, members }) {
  const isSeq = stream.mode === 'sequential';

  const sorted = React.useMemo(() => {
    if (!isSeq) return members;
    return [...members].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }, [members, isSeq]);

  // The "current/next" ticket on a sequential stream is the first member that
  // isn't done/archived. null when every member is terminal (or none exist).
  const nextId = React.useMemo(() => {
    if (!isSeq) return null;
    const next = sorted.find((t) => !SP_TERMINAL.has(t.state));
    return next ? next.id : null;
  }, [sorted, isSeq]);

  return (
    <div className="sp-stream">
      <div className="sp-stream-head">
        <span className="sp-stream-name">{stream.name}</span>
        <span className={`pill sp-mode-pill sp-mode-${stream.mode}`}>{stream.mode}</span>
        <span className="sp-stream-count tnum">{members.length}</span>
      </div>
      {stream.description && (
        <div className="sp-stream-desc">{stream.description}</div>
      )}
      {members.length === 0 ? (
        <div className="sp-stream-empty">no tickets in this stream yet.</div>
      ) : (
        <div className={`sp-members ${isSeq ? 'sequential' : 'parallel'}`}>
          {sorted.map((t, i) => (
            <StreamTicketRow
              key={t.id}
              ticket={t}
              isNext={t.id === nextId}
              ordinal={isSeq ? i + 1 : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Compact ticket row inside a stream — opens the drawer on click, mirroring the
// board's TrackerCard event. `isNext` adds the accent ring + "▶ next" tag;
// `ordinal` shows the 1-based position on sequential streams.
function StreamTicketRow({ ticket: t, isNext, ordinal }) {
  const open = () => {
    window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: t.id } }));
  };
  const terminal = SP_TERMINAL.has(t.state);
  return (
    <div
      className={`sp-ticket cc-clickable ${isNext ? 'sp-next' : ''} ${terminal ? 'sp-terminal' : ''}`}
      data-ticket-id={t.id}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <div className="sp-ticket-lead">
        {ordinal != null && <span className="sp-ticket-ord tnum">{ordinal}</span>}
        <span className="sp-ticket-id mono">{t.id}</span>
        <span className={`sp-ticket-state sp-state-${t.state}`}>{t.state}</span>
        {isNext && <span className="sp-next-tag">▶ next</span>}
      </div>
      <div className="sp-ticket-title">{t.title}</div>
    </div>
  );
}

// Inline new-stream form. createStream → the `stream-updated` WS delta upserts
// it into the store, so we just close the form on success.
function NewStreamForm({ projectId, onDone }) {
  const [name, setName] = React.useState('');
  const [mode, setMode] = React.useState('parallel');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const valid = !!name.trim();

  const onCreate = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      await window.SubstrateAPI.createStream({
        project_id: projectId,
        name: name.trim(),
        mode,
        description: description.trim() || undefined,
      });
      onDone && onDone();
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to create stream');
      setBusy(false);
    }
  };

  return (
    <div className="sp-new-form">
      <div className="sp-new-row">
        <input
          className="ct-input sp-new-name"
          type="text"
          placeholder="Stream name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <select
          className="ct-input sp-new-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          disabled={busy}
          title="Mode"
        >
          {SP_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <textarea
        className="orch-modal-textarea sp-new-desc"
        rows={2}
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={busy}
      />
      {error && <div className="ct-error sp-new-error">{error}</div>}
      <div className="sp-new-actions">
        <button className="orch-btn ghost small" onClick={() => onDone && onDone()} disabled={busy}>Cancel</button>
        <button className="orch-btn primary small" onClick={onCreate} disabled={busy || !valid}>
          {busy ? 'Creating…' : 'Create stream'}
        </button>
      </div>
    </div>
  );
}

window.StreamsPanel = StreamsPanel;
