// Ticket detail drawer (WS5b) — slides in from the right when a tracker card
// fires `open-ticket-drawer` {id}. Shows the full ticket (title/body markdown,
// inline field controls that commit immediately, a dispatch control, a live
// comment thread, and a compact links section). Mirrors the slide-in /
// chat-lane / composer pattern from drawer-ceo.jsx and reuses the .drawer-*,
// .ceo-chat, .ceo-composer, .markdown, .pill, .orch-btn styles.
//
// Live-by-store: the store's trackerTickets entry (kept fresh by `ticket-updated`
// WS deltas) is the source of truth for every field — local state is only used
// for the in-flight Edit title/body buffer. Comments live in
// Store.ticketComments: seeded after getTicket(), appended by `ticket-comment`.

const TD_STATES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'archived'];
const TD_KINDS = ['work-item', 'decision', 'spec', 'question', 'fix'];
const TD_PRIORITIES = [
  { value: '', label: 'None' },
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];
const TD_LINK_TYPES = ['blocks', 'blocked-by', 'relates-to', 'parent-of', 'child-of', 'duplicates'];

// State → .pill modifier (the pill color set is keyed off the same --status-*
// vars the board columns use). todo/archived have no dedicated pill class.
const TD_STATE_PILL = {
  todo: 'idle',
  in_progress: 'running',
  blocked: 'blocked',
  review: 'review',
  done: 'done',
  archived: 'done',
};

function tdMarkdown(text) {
  if (!text) return '';
  if (window.marked) {
    try { return window.marked.parse(String(text)); } catch { /* fall through */ }
  }
  return String(text);
}

function TicketDrawer() {
  useStore();
  const [open, setOpen] = React.useState(false);
  const [ticketId, setTicketId] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);

  // Dispatchable sessions for the open ticket's project (for assignee + dispatch).
  const [dispatchable, setDispatchable] = React.useState([]);
  const [streams, setStreams] = React.useState([]);

  // Edit buffer for title/body. null when not editing.
  const [editBuf, setEditBuf] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  // Dispatch control state.
  const [dispatchSession, setDispatchSession] = React.useState('');
  const [dispatchNote, setDispatchNote] = React.useState(null); // soft inline note text
  const [dispatching, setDispatching] = React.useState(false);

  // WS6: question return state. `returnSession` is the live session the answered
  // question is handed back to (defaults to the asker `created_by` when live).
  const [returnSession, setReturnSession] = React.useState('');
  const [returnNote, setReturnNote] = React.useState(null);
  const [returning, setReturning] = React.useState(false);

  // The live ticket from the store (kept fresh by ticket-updated deltas).
  const ticket = ticketId ? (window.Store.getState().trackerTickets.get(ticketId) ?? null) : null;
  const comments = ticketId ? window.Store.getTicketComments(ticketId) : [];
  const projects = window.Store.getProjects();
  const project = ticket
    ? (window.Store.getProjectByContractId(ticket.project_id) ?? null)
    : null;

  // Open on event; fetch full detail; seed comments into the store.
  React.useEffect(() => {
    const opener = (e) => {
      const id = e?.detail?.id;
      if (!id) return;
      setTicketId(id);
      setOpen(true);
      setEditBuf(null);
      setDispatchSession('');
      setDispatchNote(null);
      setReturnSession('');
      setReturnNote(null);
      setLoadError(null);
      setLoading(true);
      window.SubstrateAPI.getTicket(id)
        .then((full) => {
          if (full && full.id) {
            // Land the full ticket in the store so field controls have fresh values.
            window.Store.upsertTrackerTicket(full);
            window.Store.seedTicketComments(full.id, full.comments || []);
          }
          setLoading(false);
        })
        .catch((err) => {
          setLoadError(err?.message || 'Failed to load ticket');
          setLoading(false);
        });
    };
    window.addEventListener('open-ticket-drawer', opener);
    return () => window.removeEventListener('open-ticket-drawer', opener);
  }, []);

  // Esc closes.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Fetch dispatchable sessions + streams for the ticket's project.
  const projectId = ticket?.project_id || null;
  React.useEffect(() => {
    if (!open || !projectId) { setDispatchable([]); setStreams([]); return; }
    let cancelled = false;
    window.SubstrateAPI.listDispatchable(projectId)
      .then((list) => { if (!cancelled) setDispatchable(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    window.SubstrateAPI.listStreams(projectId)
      .then((list) => { if (!cancelled) setStreams(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setStreams([]); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);

  // WS6: this ticket is a question FOR the user (question-kind, assignee=human,
  // not done/archived) — drives the "Answer & return" affordance.
  const isQuestion = ticket
    ? (window.isQuestionForHuman
      ? window.isQuestionForHuman(ticket)
      : (ticket.kind === 'question' && ticket.assignee === 'human'
        && ticket.state !== 'done' && ticket.state !== 'archived'))
    : false;

  // Default the "Return to" select to the asker (created_by) when that session
  // is live in this project; else leave it empty so the user picks one.
  React.useEffect(() => {
    if (!isQuestion) return;
    const asker = ticket?.created_by || null;
    if (asker && asker !== 'human' && labelBySession.has(asker)) {
      setReturnSession((cur) => cur || asker);
    }
  }, [isQuestion, ticket?.created_by, labelBySession]);

  const resolveActor = React.useCallback((a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  }, [labelBySession]);

  // Commit a single field immediately (actor: human).
  const commitField = React.useCallback((patch) => {
    if (!ticketId) return;
    window.SubstrateAPI.updateTicket(ticketId, { ...patch, actor: 'human' })
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
      })
      .catch((err) => console.error('updateTicket failed', err));
  }, [ticketId]);

  const onSaveEdit = React.useCallback(() => {
    if (!ticketId || !editBuf) return;
    setSaving(true);
    window.SubstrateAPI.updateTicket(ticketId, {
      title: editBuf.title.trim(),
      body: editBuf.body,
      actor: 'human',
    })
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
        setEditBuf(null);
        setSaving(false);
      })
      .catch((err) => { console.error('save ticket failed', err); setSaving(false); });
  }, [ticketId, editBuf]);

  const onDispatch = React.useCallback(() => {
    if (!ticketId || !dispatchSession || dispatching) return;
    setDispatching(true);
    setDispatchNote(null);
    window.SubstrateAPI.dispatchTicket(ticketId, { session_id: dispatchSession })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        if (res && res.channel && res.channel.ok === false) {
          setDispatchNote("assigned — no live channel, it'll be picked up when that session is reachable");
        } else {
          setDispatchNote(null);
        }
        setDispatching(false);
      })
      .catch((err) => {
        console.error('dispatch failed', err);
        setDispatchNote(err?.payload?.error || err?.message || 'Dispatch failed');
        setDispatching(false);
      });
  }, [ticketId, dispatchSession, dispatching]);

  const onAddComment = React.useCallback((body) => {
    if (!ticketId) return Promise.resolve();
    // The new comment lands via the ticket-comment WS delta — don't double-insert.
    return window.SubstrateAPI.addComment(ticketId, { author: 'human', body });
  }, [ticketId]);

  // WS6: return an answered question to a live session. The dispatch is durable
  // (assignment lands on disk) even if the channel is offline — the note tells
  // the session to re-read the latest comment.
  const RETURN_NOTE = 'Your question was answered — re-read the latest comment.';
  const doReturn = React.useCallback(() => {
    if (!ticketId || !returnSession) return Promise.resolve();
    return window.SubstrateAPI.dispatchTicket(ticketId, { session_id: returnSession, note: RETURN_NOTE })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        if (res && res.channel && res.channel.ok === false) {
          setReturnNote("returned — no live channel, the session will re-read on resume");
        } else {
          setReturnNote('returned — the session was pinged to re-read the answer');
        }
        return res;
      });
  }, [ticketId, returnSession]);

  const onReturn = React.useCallback(() => {
    if (!ticketId || !returnSession || returning) return;
    setReturning(true);
    setReturnNote(null);
    doReturn()
      .catch((err) => {
        console.error('return failed', err);
        setReturnNote(err?.payload?.error || err?.message || 'Return failed');
      })
      .finally(() => setReturning(false));
  }, [ticketId, returnSession, returning, doReturn]);

  // Answer & return — post the composer's comment, THEN dispatch back in one go.
  const onAnswerAndReturn = React.useCallback((body) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.addComment(ticketId, { author: 'human', body })
      .then(() => {
        if (returnSession) return doReturn();
        return null;
      });
  }, [ticketId, returnSession, doReturn]);

  const close = () => setOpen(false);

  const statePill = ticket ? (TD_STATE_PILL[ticket.state] || 'idle') : 'idle';

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={close}/>
      <aside className={`drawer ${open ? 'open' : ''} drawer-ticket`}>
        {!open ? null : loading && !ticket ? (
          <div className="td-loading">
            <div className="drawer-header">
              <div className="drawer-title-row">
                <h2 className="drawer-title">Ticket</h2>
                <button className="drawer-close" onClick={close}><Icon.Close/></button>
              </div>
            </div>
            <div className="td-loading-body">loading ticket…</div>
          </div>
        ) : loadError && !ticket ? (
          <>
            <div className="drawer-header">
              <div className="drawer-title-row">
                <h2 className="drawer-title">Ticket</h2>
                <button className="drawer-close" onClick={close}><Icon.Close/></button>
              </div>
            </div>
            <div className="td-loading-body td-error">{loadError}</div>
          </>
        ) : !ticket ? null : (
          <>
            {/* ── Header ── */}
            <div className="drawer-header td-header">
              <div className="drawer-title-row">
                <span className="td-id mono">{ticket.id}</span>
                <span className="pill td-kind-pill">{ticket.kind}</span>
                {project && (
                  <span className="cc-chip td-project-chip" title={project.name}>
                    <span className="cc-chip-dot" style={{ background: project.color }}/>
                    <span className="cc-chip-text">{project.glyph ? `${project.glyph} ` : ''}{project.name}</span>
                  </span>
                )}
                <span className={`pill ${statePill}`}>{ticket.state}</span>
                {isQuestion && <span className="pill td-answer-badge">❓ needs answer</span>}
                <button className="drawer-close" onClick={close}><Icon.Close/></button>
              </div>
              <div className="drawer-meta td-meta">
                <div className="drawer-meta-item" title={ticket.created_at || ''}>
                  <span className="drawer-meta-key">created</span>
                  <span className="drawer-meta-val">{tdAgo(ticket.created_at)}</span>
                </div>
                <div className="drawer-meta-item" title={ticket.updated_at || ''}>
                  <span className="drawer-meta-key">updated</span>
                  <span className="drawer-meta-val">{tdAgo(ticket.updated_at)}</span>
                </div>
              </div>
            </div>

            <div className="td-scroll">
              {/* ── Title + body (with Edit toggle) ── */}
              {editBuf ? (
                <div className="td-edit">
                  <input
                    className="td-edit-title"
                    type="text"
                    value={editBuf.title}
                    onChange={(e) => setEditBuf({ ...editBuf, title: e.target.value })}
                    placeholder="Title"
                  />
                  <textarea
                    className="td-edit-body orch-modal-textarea"
                    rows={8}
                    value={editBuf.body}
                    onChange={(e) => setEditBuf({ ...editBuf, body: e.target.value })}
                    placeholder="Body (markdown)"
                  />
                  <div className="td-edit-actions">
                    <button className="orch-btn ghost" onClick={() => setEditBuf(null)} disabled={saving}>Cancel</button>
                    <button className="orch-btn primary" onClick={onSaveEdit} disabled={saving || !editBuf.title.trim()}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="td-titlebody">
                  <div className="td-title-row">
                    <h2 className="td-title">{ticket.title}</h2>
                    <button
                      className="orch-btn small ghost td-edit-btn"
                      onClick={() => setEditBuf({ title: ticket.title || '', body: ticket.body || '' })}
                    >
                      Edit
                    </button>
                  </div>
                  {ticket.body ? (
                    <div className="markdown td-body" dangerouslySetInnerHTML={{ __html: tdMarkdown(ticket.body) }}/>
                  ) : (
                    <div className="td-body-empty">No description.</div>
                  )}
                </div>
              )}

              {/* ── Inline field controls ── */}
              <div className="td-fields">
                <TdField label="State">
                  <select className="td-select" value={ticket.state}
                    onChange={(e) => commitField({ state: e.target.value })}>
                    {TD_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </TdField>

                <TdField label="Assignee">
                  <select className="td-select" value={ticket.assignee || ''}
                    onChange={(e) => commitField({ assignee: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    <option value="human">Human (You)</option>
                    {dispatchable.map((s) => (
                      <option key={s.session_id} value={s.session_id}>{s.label}</option>
                    ))}
                    {/* Keep an offline assignee selectable if it isn't in the live list. */}
                    {ticket.assignee && ticket.assignee !== 'human'
                      && !labelBySession.has(ticket.assignee) && (
                      <option value={ticket.assignee}>
                        session {String(ticket.assignee).slice(0, 8)} (offline)
                      </option>
                    )}
                  </select>
                </TdField>

                <TdField label="Priority">
                  <select className="td-select" value={ticket.priority || ''}
                    onChange={(e) => commitField({ priority: e.target.value || null })}>
                    {TD_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </TdField>

                <TdField label="Kind">
                  <select className="td-select" value={ticket.kind}
                    onChange={(e) => commitField({ kind: e.target.value })}>
                    {TD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </TdField>

                <TdField label="Stream">
                  <select className="td-select" value={ticket.stream_id || ''}
                    onChange={(e) => commitField({ stream_id: e.target.value || null })}>
                    <option value="">None</option>
                    {streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </TdField>
              </div>

              {/* ── Dispatch ── */}
              <div className="td-dispatch">
                <div className="td-section-title">Dispatch</div>
                {(ticket.dispatched_to || ticket.dispatched_at) && (
                  <div className="td-dispatch-current">
                    dispatched to <span className="mono">{resolveActor(ticket.dispatched_to)}</span>
                    {ticket.dispatched_at && <> · {tdAgo(ticket.dispatched_at)}</>}
                  </div>
                )}
                <div className="td-dispatch-row">
                  <select className="td-select" value={dispatchSession}
                    onChange={(e) => setDispatchSession(e.target.value)}
                    disabled={dispatching || dispatchable.length === 0}>
                    <option value="">
                      {dispatchable.length === 0 ? 'No live session in this project' : 'Select a live session…'}
                    </option>
                    {dispatchable.map((s) => (
                      <option key={s.session_id} value={s.session_id}>{s.label}</option>
                    ))}
                  </select>
                  <button className="orch-btn"
                    onClick={onDispatch}
                    disabled={dispatching || !dispatchSession || dispatchable.length === 0}
                    title={dispatchable.length === 0 ? 'No live session in this project to dispatch to' : 'Dispatch to the selected session'}>
                    {dispatching ? 'Dispatching…' : 'Dispatch'}
                  </button>
                </div>
                {dispatchable.length === 0 && (
                  <div className="td-dispatch-hint">
                    No live session in this project — start one with <span className="mono">cd &lt;project&gt; &amp;&amp; claude</span>.
                  </div>
                )}
                {dispatchNote && <div className="td-dispatch-note">{dispatchNote}</div>}
              </div>

              {/* ── Links (compact, secondary) ── */}
              <TicketLinks ticketId={ticket.id} links={ticket.links || []}/>

              {/* ── Comment thread ── */}
              <div className="td-comments">
                <div className="td-section-title">Comments <span className="td-count tnum">{comments.length}</span></div>
                <TicketCommentThread comments={comments} resolveActor={resolveActor}/>
              </div>
            </div>

            {isQuestion ? (
              <QuestionReturn
                onComment={onAddComment}
                onReturn={onReturn}
                onAnswerAndReturn={onAnswerAndReturn}
                returnSession={returnSession}
                setReturnSession={setReturnSession}
                dispatchable={dispatchable}
                returning={returning}
                note={returnNote}
                ticket={ticket}
                labelBySession={labelBySession}
              />
            ) : (
              <TdComposer onSubmit={onAddComment}/>
            )}
          </>
        )}
      </aside>
    </>
  );
}

function tdAgo(iso) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return window.SubstrateFmt?.fmtTimeAgo?.(t) || '';
}

function TdField({ label, children }) {
  return (
    <label className="td-field">
      <span className="td-field-label">{label}</span>
      {children}
    </label>
  );
}

// Comment thread — reuses the .ceo-chat message-list structure.
function TicketCommentThread({ comments, resolveActor }) {
  const ref = React.useRef(null);
  const stick = React.useRef(true);

  const onScroll = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  React.useEffect(() => {
    if (!stick.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments]);

  if (!comments.length) {
    return <div className="td-comments-empty">No comments yet.</div>;
  }
  return (
    <div className="ceo-chat td-comment-list" ref={ref} onScroll={onScroll}>
      {comments.map((c) => (
        <div className="ceo-msg role-user kind-comment td-comment" key={c.id}>
          <div className="ceo-msg-head">
            <span className="ceo-msg-label">{resolveActor(c.author)}</span>
            <span className="ceo-msg-ts">{tdAgo(c.created_at)}</span>
          </div>
          <div className="ceo-msg-body markdown" dangerouslySetInnerHTML={{ __html: tdMarkdown(c.body) }}/>
        </div>
      ))}
    </div>
  );
}

// Comment composer — mirrors drawer-ceo's Composer (Cmd/Ctrl+Enter to send).
function TdComposer({ onSubmit }) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const taRef = React.useRef(null);

  const submit = React.useCallback(async () => {
    if (busy) return;
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onSubmit(t);
      setText('');
      taRef.current?.focus();
    } catch (err) {
      console.error('addComment failed', err);
    } finally {
      setBusy(false);
    }
  }, [busy, onSubmit, text]);

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  };

  return (
    <form className="ceo-composer td-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={taRef}
        className="ceo-composer-input"
        rows={2}
        placeholder="Add a comment…  (⌘/Ctrl + Enter to send)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={busy}
      />
      <button type="submit" className="orch-btn primary" disabled={busy || !text.trim()}>Comment</button>
    </form>
  );
}

// WS6: the "Answer & return" affordance for a question-kind ticket. Combines the
// comment composer (the answer) with a "Return to ▾" live-session select and two
// actions: "Return" (re-dispatch to ping the asker) and "Answer & return" (post
// the comment THEN dispatch in one go). The answer always posts even with no
// live session — only the return ping is gated on a reachable session.
function QuestionReturn({
  onComment, onReturn, onAnswerAndReturn, returnSession, setReturnSession,
  dispatchable, returning, note, ticket, labelBySession,
}) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const taRef = React.useRef(null);

  const hasSessions = dispatchable.length > 0;
  const trimmed = text.trim();

  // The asker (created_by) may be offline — surface it as a disabled note rather
  // than hiding it, so the user understands why the default isn't pre-selected.
  const asker = ticket?.created_by && ticket.created_by !== 'human' ? ticket.created_by : null;
  const askerOffline = asker && !labelBySession.has(asker);

  const postComment = React.useCallback(async () => {
    if (busy || !trimmed) return;
    setBusy(true);
    try {
      await onComment(trimmed);
      setText('');
      taRef.current?.focus();
    } catch (err) {
      console.error('answer comment failed', err);
    } finally {
      setBusy(false);
    }
  }, [busy, trimmed, onComment]);

  const answerAndReturn = React.useCallback(async () => {
    if (busy || !trimmed || !returnSession) return;
    setBusy(true);
    try {
      await onAnswerAndReturn(trimmed);
      setText('');
    } catch (err) {
      console.error('answer & return failed', err);
    } finally {
      setBusy(false);
    }
  }, [busy, trimmed, returnSession, onAnswerAndReturn]);

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
  };

  const disabled = busy || returning;

  return (
    <div className="td-question-return">
      <div className="td-qr-title">❓ Answer &amp; return</div>
      <textarea
        ref={taRef}
        className="ceo-composer-input td-qr-input"
        rows={2}
        placeholder="Write your answer…  (⌘/Ctrl + Enter posts the answer)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled}
      />
      <div className="td-qr-return-row">
        <label className="td-qr-return-label">Return to</label>
        <select
          className="td-select td-qr-select"
          value={returnSession}
          onChange={(e) => setReturnSession(e.target.value)}
          disabled={disabled || !hasSessions}
          title={hasSessions ? 'Pick a live session to hand the answer back to' : 'No live session in this project'}
        >
          <option value="">
            {hasSessions ? 'Select a live session…' : 'No live session in this project'}
          </option>
          {dispatchable.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {s.label}{s.session_id === asker ? ' (asker)' : ''}
            </option>
          ))}
        </select>
      </div>
      {askerOffline && (
        <div className="td-qr-hint">
          The asking session <span className="mono">{String(asker).slice(0, 8)}</span> is offline — your answer still
          posts; pick another live session to ping, or it'll be re-read on resume.
        </div>
      )}
      {!hasSessions && (
        <div className="td-qr-hint">
          No live session in this project — your answer posts regardless; the asker re-reads it on resume.
        </div>
      )}
      {note && <div className="td-qr-note">{note}</div>}
      <div className="td-qr-actions">
        <button
          className="orch-btn"
          onClick={postComment}
          disabled={disabled || !trimmed}
          title="Post the answer as a comment without returning"
        >
          {busy ? 'Posting…' : 'Post answer'}
        </button>
        <button
          className="orch-btn ghost"
          onClick={onReturn}
          disabled={disabled || !returnSession}
          title={returnSession ? 'Re-dispatch this question to the selected session' : 'Pick a live session first'}
        >
          {returning ? 'Returning…' : 'Return'}
        </button>
        <button
          className="orch-btn primary"
          onClick={answerAndReturn}
          disabled={disabled || !trimmed || !returnSession}
          title={!returnSession ? 'Pick a live session to return to' : 'Post the answer then return to the selected session'}
        >
          Answer &amp; return
        </button>
      </div>
    </div>
  );
}

// Compact links section — list existing links + a minimal add form.
function TicketLinks({ ticketId, links }) {
  const [adding, setAdding] = React.useState(false);
  const [toTicket, setToTicket] = React.useState('');
  const [type, setType] = React.useState(TD_LINK_TYPES[0]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const onAdd = () => {
    const to = toTicket.trim();
    if (!to || busy) return;
    setBusy(true); setErr(null);
    window.SubstrateAPI.addLink(ticketId, { to_ticket: to, type })
      .then(() => {
        // The server emits a ticket-updated delta that refreshes ticket.links.
        setToTicket(''); setAdding(false); setBusy(false);
      })
      .catch((e) => { setErr(e?.payload?.error || e?.message || 'Failed to add link'); setBusy(false); });
  };

  const onRemove = (l) => {
    window.SubstrateAPI.removeLink(ticketId, { to_ticket: l.to_ticket, type: l.type })
      .catch((e) => console.error('removeLink failed', e));
  };

  // Only links that hang off this ticket (from_ticket === id) are removable
  // here; inbound links are shown for context.
  return (
    <div className="td-links">
      <div className="td-section-title">
        Links <span className="td-count tnum">{links.length}</span>
        <button className="orch-btn small ghost td-link-add-btn" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : '+ Link'}
        </button>
      </div>
      {links.length > 0 && (
        <ul className="td-link-list">
          {links.map((l, i) => {
            const outbound = l.from_ticket === ticketId;
            const other = outbound ? l.to_ticket : l.from_ticket;
            return (
              <li key={`${l.from_ticket}-${l.to_ticket}-${l.type}-${i}`} className="td-link-row">
                <span className="td-link-type">{outbound ? l.type : `${l.type} (in)`}</span>
                <span className="td-link-target mono">{other}</span>
                {outbound && (
                  <button className="td-link-remove" title="remove link" onClick={() => onRemove(l)}>×</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <div className="td-link-add">
          <input className="td-select td-link-input" type="text" placeholder="target ticket id"
            value={toTicket} onChange={(e) => setToTicket(e.target.value)}/>
          <select className="td-select" value={type} onChange={(e) => setType(e.target.value)}>
            {TD_LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="orch-btn small" onClick={onAdd} disabled={busy || !toTicket.trim()}>Add</button>
        </div>
      )}
      {err && <div className="td-link-err">{err}</div>}
    </div>
  );
}

window.TicketDrawer = TicketDrawer;
