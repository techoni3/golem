// Ticket detail drawer — slides in from the right when a tracker card fires
// `open-ticket-drawer` {id}. Shows the full ticket with an html-report-style
// HTML body + inline annotations, inline field controls, dispatch, links.
//
// Live-by-store: the store's trackerTickets entry (kept fresh by `ticket-updated`
// WS deltas) is the source of truth for every field. Comments are seeded after
// getTicket() and appended by `ticket-comment` / `ticket-comment-updated`. The
// annotation UI renders them as anchored highlights + a right rail.

const TD_STATES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'archived'];
const TD_KINDS = ['work-item', 'decision', 'spec', 'question', 'fix'];
const TD_PRIORITIES = [
  { value: '', label: 'None' },
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];

// Drawer width presets (percentage of viewport width). Persisted in
// localStorage so a refresh keeps the user's choice. Order is wide→narrow,
// matching the icon button group left-to-right.
// TKT-0285: the 30% (Narrow) preset is gone — a sidebar is impossible at that
// width. Two presets now: 90 (Wide) + 50 (Half). tdLoadWidth coerces a stored
// '30' to '50' one-time so nobody lands on a broken width.
const TD_WIDTHS = [
  { v: '90', icon: () => <Icon.DrawerWide/>, label: 'Wide (90%)' },
  { v: '50', icon: () => <Icon.DrawerHalf/>, label: 'Half (50%)' },
];
const TD_WIDTH_KEY = 'td:width';
function tdLoadWidth() {
  try {
    let s = localStorage.getItem(TD_WIDTH_KEY);
    // TKT-0285: the 30% preset is gone — coerce a stored '30' to '50' and
    // persist it back so the migration is one-time (not a broken blank width).
    if (s === '30') { s = '50'; try { localStorage.setItem(TD_WIDTH_KEY, s); } catch {} }
    return TD_WIDTHS.some((w) => w.v === s) ? s : '90';
  } catch { return '90'; }
}

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


function TicketDrawer({ open, ticketId, onClose, variant = 'overlay' }) {
  useStore();
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);

  // Dispatchable sessions for the open ticket's project (for assignee + dispatch).
  const [dispatchable, setDispatchable] = React.useState([]);
  const [streams, setStreams] = React.useState([]);

  // Edit buffer for title/body. null when not editing.
  const [editBuf, setEditBuf] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  // TKT-0233: inline title edit (click the h2 to edit; Enter/blur commits, Esc reverts).
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const titleInputRef = React.useRef(null);

  // Drawer width preset (persisted) + field-controls collapse (collapsed by
  // default; the body/state/assignee/priority fields are rarely changed and
  // take vertical space that info/report tickets need for prose).
  const [widthPct, setWidthPct] = React.useState(tdLoadWidth);
  const [fieldsExpanded, setFieldsExpanded] = React.useState(false);
  const setWidth = (v) => {
    setWidthPct(v);
    try { localStorage.setItem(TD_WIDTH_KEY, v); } catch {}
  };

  // Dispatch control state.
  const [dispatchSession, setDispatchSession] = React.useState('');
  const [dispatchNote, setDispatchNote] = React.useState(null); // soft inline note text
  const [dispatching, setDispatching] = React.useState(false);
  // TKT-0245: 'now' | 'when_idle' — default follows the selected target's live
  // status (idle→Now, busy/waiting→When idle); the user can override via the
  // segmented toggle. `cancelling` gates the Cancel button on a pending row.
  const [dispatchMode, setDispatchMode] = React.useState('now');
  const [cancelling, setCancelling] = React.useState(false);

  // WS6: question return state. `returnSession` is the live session the answered
  // question is handed back to (defaults to the asker `created_by` when live).
  const [returnSession, setReturnSession] = React.useState('');
  const [returnNote, setReturnNote] = React.useState(null);
  const [returning, setReturning] = React.useState(false);

  // The live ticket from the store (kept fresh by ticket-updated deltas).
  const ticket = ticketId ? (window.Store.getState().trackerTickets.get(ticketId) ?? null) : null;
  const flatComments = ticketId ? window.Store.getTicketComments(ticketId) : [];
  // Group flat top-level comments + replies by parent_id. The schema stores
  // replies as separate rows (parent_id set), but the annotation rail renders
  // them nested under their parent card — so assemble the tree here.
  const comments = React.useMemo(() => {
    const tops = [];
    const repliesByParent = new Map();
    for (const c of flatComments) {
      if (c.parent_id) {
        const arr = repliesByParent.get(c.parent_id) ?? [];
        arr.push({ author: c.author, text: c.body, ts: c.created_at, id: c.id });
        repliesByParent.set(c.parent_id, arr);
      } else {
        tops.push(c);
      }
    }
    return tops.map((t) => ({
      ...t,
      replies: (repliesByParent.get(t.id) ?? []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts))),
    }));
  }, [flatComments]);
  const projects = window.Store.getProjects();
  const project = ticket
    ? (window.Store.getProjectByContractId(ticket.project_id) ?? null)
    : null;

  // Open state is URL-driven (App passes open + ticketId from ?ticket=<id>).
  // When the drawer opens (or switches tickets), fetch full detail + seed
  // comments into the store so field controls have fresh values.
  React.useEffect(() => {
    if (!open || !ticketId) return;
    setEditBuf(null);
    setDispatchSession('');
    setDispatchNote(null);
    setReturnSession('');
    setReturnNote(null);
    setLoadError(null);
    setLoading(true);
    let cancelled = false;
    window.SubstrateAPI.getTicket(ticketId)
      .then((full) => {
        if (cancelled) return;
        if (full && full.id) {
          window.Store.upsertTrackerTicket(full);
          window.Store.seedTicketComments(full.id, full.comments || []);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err?.message || 'Failed to load ticket');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, ticketId]);

  // Esc closes (→ App pops the ?ticket overlay via onClose).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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

  // TKT-0245: decorate dispatch picker options with live status dots + hints.
  // Join the dispatchable list with the store's nativeSessions (updated every
  // 3s via WS) by session_id so the dots re-render live; pending_count comes
  // from the dispatchable REST response.
  const nativeSessionsNow = window.Store.getState().nativeSessions;
  const dispatchOptions = React.useMemo(() => {
    const liveStatus = new Map();
    for (const s of nativeSessionsNow) {
      if (s.session_id) liveStatus.set(s.session_id, s.status ?? null);
    }
    return dispatchable.map((s) => {
      const status = liveStatus.get(s.session_id) ?? s.status ?? null;
      const dot = status === 'idle' ? 'var(--status-active)'
        : status === 'busy' ? 'var(--status-running)'
        : status === 'waiting' ? 'var(--status-review)'
        : 'var(--text-3)';
      let hint = status === 'idle' ? 'idle'
        : status === 'busy' ? 'working'
        : status === 'waiting' ? 'waiting'
        : '—';
      if (s.pending_count > 0) hint += ` · ${s.pending_count} queued`;
      return { value: s.session_id, label: s.label, dot, hint };
    });
  }, [dispatchable, nativeSessionsNow]);

  // TKT-0245: pending dispatch (embedded in ticket detail by the server). When
  // set, the dispatch row is replaced by a status line + Cancel button. The
  // store refreshes the ticket on every ticket-updated WS, so this is live.
  const pendingDispatch = ticket?.pending_dispatch ?? null;
  const pendingTargetOffline = (() => {
    if (!pendingDispatch) return false;
    const s = window.Store.getNativeSessionById?.(pendingDispatch.session_id);
    return !s || !s.alive;
  })();
  const pendingLabel = pendingDispatch
    ? (labelBySession.get(pendingDispatch.session_id)
      || window.Store.getNativeSessionById?.(pendingDispatch.session_id)?.name
      || `session ${String(pendingDispatch.session_id).slice(0, 8)}`)
    : null;

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

  const resolveActor = React.useCallback((a, persistedLabel) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    // TKT-0266: prefer the durable persisted label (from session_labels) so
    // the meta strip still shows the friendly name after the session goes
    // offline. Falls back to the live resolver, then the uuid stub.
    return persistedLabel || labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
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

  // TKT-0233: body-only edit. editBuf is now { body } (title is edited inline).
  const onSaveEdit = React.useCallback(() => {
    if (!ticketId || !editBuf) return;
    setSaving(true);
    window.SubstrateAPI.updateTicket(ticketId, { body: editBuf.body, actor: 'human' })
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
        setEditBuf(null);
        setSaving(false);
      })
      .catch((err) => { console.error('save ticket failed', err); setSaving(false); });
  }, [ticketId, editBuf]);

  // TKT-0233: inline title edit — click the h2 to edit, Enter/blur commits, Esc reverts.
  const startTitleEdit = React.useCallback(() => {
    setTitleDraft(ticket?.title || '');
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [ticket]);
  const commitTitle = React.useCallback(() => {
    const t = (titleDraft || '').trim();
    setEditingTitle(false);
    if (t && ticket && t !== ticket.title) commitField({ title: t });
  }, [titleDraft, ticket, commitField]);

  const onDispatch = React.useCallback(() => {
    if (!ticketId || !dispatchSession || dispatching) return;
    setDispatching(true);
    setDispatchNote(null);
    window.SubstrateAPI.dispatchTicket(ticketId, { session_id: dispatchSession, mode: dispatchMode })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        // Re-fetch dispatchable so pending_count hints refresh in the picker.
        if (projectId) {
          window.SubstrateAPI.listDispatchable(projectId)
            .then((list) => setDispatchable(Array.isArray(list) ? list : []))
            .catch(() => {});
        }
        if (res?.queued) {
          setDispatchNote(null); // the pending row renders in place of the dispatch row
        } else if (res && res.channel && res.channel.ok === false) {
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
  }, [ticketId, dispatchSession, dispatching, dispatchMode, projectId]);

  // TKT-0245: cancel a queued dispatch. The server broadcasts a ticket-updated
  // (pending_dispatch gone) so the store refreshes the ticket and the drawer
  // re-renders back to the dispatch row.
  const onCancelDispatch = React.useCallback(() => {
    const pending = ticket?.pending_dispatch;
    if (!pending || cancelling) return;
    setCancelling(true);
    window.SubstrateAPI.cancelDispatchQueue(pending.id)
      .then(() => {
        if (projectId) {
          window.SubstrateAPI.listDispatchable(projectId)
            .then((list) => setDispatchable(Array.isArray(list) ? list : []))
            .catch(() => {});
        }
        setCancelling(false);
      })
      .catch((err) => {
        console.error('cancel dispatch failed', err);
        setCancelling(false);
      });
  }, [ticket, cancelling, projectId]);

  // Add a plain or inline-anchored comment. `input` can be a string (legacy)
  // or an object with { body, quote?, prefix?, suffix?, section?, section_id?, tag? }.
  const onAddComment = React.useCallback((input) => {
    if (!ticketId) return Promise.resolve();
    const payload = typeof input === 'string' ? { author: 'human', body: input } : { author: 'human', ...input };
    return window.SubstrateAPI.addComment(ticketId, payload);
  }, [ticketId]);

  const onUpdateComment = React.useCallback((commentId, patch) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.updateComment(ticketId, commentId, patch);
  }, [ticketId]);

  const onReplyComment = React.useCallback((parentId, reply) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.replyComment(ticketId, parentId, { author: 'human', body: reply.text });
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

  const close = () => onClose && onClose();

  const statePill = ticket ? (TD_STATE_PILL[ticket.state] || 'idle') : 'idle';
  // TKT-0266: rotating gear next to the state pill when the ticket is being
  // actively worked (in_progress + busy live assignee). Same rule as the board
  // card; re-renders on store updates so it tracks the 3s session refresh.
  const activelyWorked = ticket ? (window.isActivelyWorked ? window.isActivelyWorked(ticket) : false) : false;

  // variant='page' renders the same ticket content in a standalone page layout
  // (no fixed drawer shell / backdrop / width presets) so /tickets/<id> can be
  // a dedicated screen. The annotation pill portals to containerSelector.
  const isPage = variant === 'page';
  const containerSelector = isPage ? '.ticket-page' : '.drawer-ticket';
  const projectHref = project
    ? window.Router.buildHref({ kind: 'project', id: project.id, tab: 'agents' })
    : null;
  const Shell = isPage ? 'div' : 'aside';
  const shellClass = isPage
    ? `ticket-page${isQuestion ? ' td-has-question-return' : ''}`
    : `drawer ${open ? 'open' : ''} drawer-ticket${isQuestion ? ' td-has-question-return' : ''}`;
  const shellStyle = isPage ? undefined : { width: `${widthPct}vw` };

  return (
    <>
      {isPage ? null : (
        <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={close}/>
      )}
      <Shell className={shellClass} style={shellStyle}>
        {!open && !isPage ? null : loading && !ticket ? (
          <div className="td-loading">
            <div className="drawer-header">
              <div className="drawer-title-row">
                <h2 className="drawer-title">Ticket</h2>
                {isPage ? null : <button className="drawer-close" onClick={close}><Icon.Close/></button>}
              </div>
            </div>
            <div className="td-loading-body">loading ticket…</div>
          </div>
        ) : loadError && !ticket ? (
          <>
            <div className="drawer-header">
              <div className="drawer-title-row">
                <h2 className="drawer-title">Ticket</h2>
                {isPage ? null : <button className="drawer-close" onClick={close}><Icon.Close/></button>}
              </div>
            </div>
            <div className="td-loading-body td-error">{loadError}</div>
          </>
        ) : !ticket ? null : (
          <>
            {/* ── Header ── */}
            <div className="drawer-header td-header">
              <div className="drawer-title-row">
                {isPage && projectHref && (
                  <a className="td-back-link" href={projectHref}
                    onClick={(e) => { e.preventDefault(); window.Router.go({ kind: 'project', id: project.id, tab: 'agents' }); }}
                    title={`Back to ${project?.name}`}>
                    ← {project?.name}
                  </a>
                )}
                <span className="td-id mono">{ticket.id}</span>
                <span className="pill td-kind-pill" data-kind={ticket.kind}>{ticket.kind}</span>
                {project && (
                  <span className="cc-chip td-project-chip" title={project.name}>
                    <span className="cc-chip-dot" style={{ background: project.color }}/>
                    <span className="cc-chip-text">{project.glyph ? `${project.glyph} ` : ''}{project.name}</span>
                  </span>
                )}
                <span className={`pill ${statePill}`}>{ticket.state}</span>
                {activelyWorked && <Icon.Gear size={12} className="gear gear-working" title="assignee is actively working"/>}
                {isQuestion && (
                  <span
                    className="pill td-answer-badge"
                    title="This is a question-kind ticket assigned to you. The asker (usually a Claude session) is blocked until you post an answer in the composer below. You can post just the answer, or post + re-dispatch the question back to a live session."
                  >
                    ❓ needs answer
                  </span>
                )}
                {isPage ? null : (
                  <button
                    className={`td-width-btn ${widthPct === '90' ? 'active' : ''}`}
                    onClick={() => setWidth(widthPct === '90' ? '50' : '90')}
                    title="Toggle drawer width (90% ⇄ 50%)"
                    aria-pressed={widthPct === '90'}
                  >{widthPct === '90' ? <Icon.DrawerWide/> : <Icon.DrawerHalf/>}</button>
                )}
                {isPage ? null : (
                  <a className="td-open-page" href={window.Router.buildHref({ kind: 'ticket', id: ticket.id })}
                    target="_blank" rel="noopener" title="Open as standalone page (new tab)">↗</a>
                )}
                {isPage ? null : <button className="drawer-close" onClick={close}><Icon.Close/></button>}
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
              {/* TKT-0285: fields sidebar — the .td-props panel (TKT-0233) moves
                  into a sticky left .td-side; the title + body + (0284) Work-items
                  panel live in .td-main, which re-centers within the remaining
                  horizontal space (gutters both sides). The annotation rail
                  (comments on the right) is untouched. align-items: flex-start is
                  REQUIRED on .td-layout or the sticky sidebar never engages. */}
              <div className="td-layout">
              <aside className="td-side">
              {/* ── Properties panel (TKT-0233 → TKT-0285 moved into the sidebar) —
                   PopSelect controls; 0245's dispatch block + 0266's meta move with it. ── */}
              <div className="td-props">
                <div className="td-prop">
                  <span className="td-prop-label">State</span>
                  <PopSelect
                    value={ticket.state}
                    compact
                    options={TD_STATES.map((s) => ({ value: s, label: s, dot: PS_STATE_DOT[s] }))}
                    onChange={(v) => commitField({ state: v })}
                  />
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">Assignee</span>
                  <PopSelect
                    value={ticket.assignee || ''}
                    placeholder="Unassigned"
                    searchable
                    compact
                    options={[
                      { value: '', label: 'Unassigned' },
                      { value: 'human', label: 'You' },
                      ...dispatchable.map((s) => ({ value: s.session_id, label: s.label })),
                      ...(ticket.assignee && ticket.assignee !== 'human' && !labelBySession.has(ticket.assignee)
                        // TKT-0266: prefer the persisted durable label so the
                        // offline option shows the friendly name (e.g.
                        // "golem:builder (offline)") instead of a uuid stub.
                        ? [{ value: ticket.assignee, label: ticket.assignee_label || `session ${String(ticket.assignee).slice(0, 8)}`, hint: 'offline' }]
                        : []),
                    ]}
                    onChange={(v) => commitField({ assignee: v || null })}
                  />
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">Priority</span>
                  <PopSelect
                    value={ticket.priority || ''}
                    placeholder="None"
                    compact
                    options={TD_PRIORITIES.map((p) => ({ value: p.value, label: p.label || 'None', badge: p.value || undefined }))}
                    onChange={(v) => commitField({ priority: v || null })}
                  />
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">Type</span>
                  <PopSelect
                    value={ticket.kind}
                    compact
                    options={TD_KINDS.map((k) => ({ value: k, label: k }))}
                    onChange={(v) => commitField({ kind: v })}
                  />
                </div>
                <div className="td-prop td-prop-full">
                  <span className="td-prop-label">Stream</span>
                  <PopSelect
                    value={ticket.stream_id || ''}
                    placeholder="None"
                    compact
                    options={[{ value: '', label: 'None' }, ...streams.map((s) => ({ value: s.id, label: s.name }))]}
                    onChange={(v) => commitField({ stream_id: v || null })}
                  />
                </div>

                {/* Dispatch — an action, not a property; full-width, separated.
                    TKT-0245: when a dispatch is queued (ticket.pending_dispatch
                    set), the row becomes a status line + Cancel; otherwise the
                    PopSelect (with live status dots) + Now/When-idle mode toggle
                    + Dispatch/Queue button. Disabled/empty-picker behavior from
                    TKT-0233 is preserved verbatim. */}
                {pendingDispatch ? (
                  <div className="td-prop-dispatch td-dispatch-pending">
                    <span className="td-prop-label">Dispatch</span>
                    <span className="td-dispatch-pending-line">
                      <span className="td-dispatch-pending-icon">⏳</span>
                      Queued for {pendingLabel} · {tdAgo(pendingDispatch.created_at)} · waiting for idle
                      {pendingTargetOffline && <span className="td-dispatch-pending-offline"> · session offline</span>}
                    </span>
                    <button className="orch-btn small ghost td-dispatch-cancel"
                      onClick={onCancelDispatch}
                      disabled={cancelling}
                      title="Cancel this queued dispatch">
                      {cancelling ? '…' : 'Cancel'}
                    </button>
                  </div>
                ) : (
                  <div className="td-prop-dispatch">
                    <span className="td-prop-label">Dispatch to</span>
                    <PopSelect
                      value={dispatchSession}
                      placeholder={dispatchable.length === 0 ? 'No session' : 'Session…'}
                      compact
                      disabled={dispatching || dispatchable.length === 0}
                      options={dispatchOptions}
                      onChange={(v) => {
                        setDispatchSession(v);
                        // Default the mode from the selected target's live
                        // status: idle → Now, busy/waiting → When idle (the
                        // user can override via the toggle below).
                        const sel = dispatchable.find((s) => s.session_id === v);
                        const liveSt = nativeSessionsNow.find((s) => s.session_id === v)?.status ?? null;
                        const st = sel ? (liveSt ?? sel.status ?? null) : null;
                        setDispatchMode(st === 'idle' ? 'now' : 'when_idle');
                      }}
                    />
                    <div className="td-dispatch-actions">
                      <div className="td-dispatch-mode" role="group" aria-label="Dispatch mode">
                        <button type="button" className={`td-dispatch-mode-btn${dispatchMode === 'now' ? ' active' : ''}`}
                          onClick={() => setDispatchMode('now')} aria-pressed={dispatchMode === 'now'} title="Push the brief immediately">Now</button>
                        <button type="button" className={`td-dispatch-mode-btn${dispatchMode === 'when_idle' ? ' active' : ''}`}
                          onClick={() => setDispatchMode('when_idle')} aria-pressed={dispatchMode === 'when_idle'} title="Queue the brief until the target session is idle">When idle</button>
                      </div>
                      <button className="orch-btn small td-dispatch-go"
                        onClick={onDispatch}
                        disabled={dispatching || !dispatchSession || dispatchable.length === 0}
                        title={dispatchable.length === 0 ? 'No live session in this project — start one with `cd <project> && claude`' : (dispatchMode === 'when_idle' ? 'Queue the dispatch until the target session is idle' : 'Dispatch to the selected session')}>
                        {dispatching ? '…' : (dispatchMode === 'when_idle' ? 'Queue' : 'Dispatch')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Meta strip — collapsed by default */}
                <div className="td-meta-strip">
                  <button className="td-meta-toggle" onClick={() => setFieldsExpanded((e) => !e)} aria-expanded={fieldsExpanded} title={fieldsExpanded ? 'Hide metadata' : 'Show metadata'}>
                    <Icon.ChevronRight/>
                    <span>{fieldsExpanded ? 'Less' : 'More'}</span>
                  </button>
                  {fieldsExpanded && (
                    <div className="td-meta-list">
                      <div className="td-meta-row">
                        <span className="td-meta-key">Dispatched to</span>
                        <span className="mono">{resolveActor(ticket.dispatched_to, ticket.dispatched_to_label) || '—'}</span>
                        {ticket.dispatched_at && <span className="td-meta-value">· {tdAgo(ticket.dispatched_at)}</span>}
                      </div>
                      <div className="td-meta-row">
                        <span className="td-meta-key">Created by</span>
                        <span>{ticket.created_by && ticket.created_by !== 'human' ? ticket.created_by.slice(0, 8) : 'You'}</span>
                        <span className="td-meta-value">· {tdAgo(ticket.created_at)}</span>
                      </div>
                      <div className="td-meta-row">
                        <span className="td-meta-key">Updated</span>
                        <span className="td-meta-value">{tdAgo(ticket.updated_at)}</span>
                      </div>
                    </div>
                  )}
                </div>

                {dispatchNote && !pendingDispatch && <div className="td-dispatch-note">{dispatchNote}</div>}
              </div>
              </aside>

              {/* TKT-0285: main column — title + body + (0284) Work-items panel.
                  The title + .td-md re-center within .td-main (gutters both sides);
                  the annotation-rail reserve now lives on .td-main. */}
              <div className="td-main">
              {/* ── Title — document heading, click to inline-edit (TKT-0233) ── */}
              <div className="td-titlebody">
                <div className="td-title-row">
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      className="td-title-input"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
                        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditingTitle(false); }
                      }}
                      onBlur={commitTitle}
                      placeholder="Title"
                    />
                  ) : (
                    <h2 className="td-title" onClick={startTitleEdit} title="Click to edit">{ticket.title}</h2>
                  )}
                  <button
                    className="orch-btn small ghost td-edit-btn"
                    onClick={() => setEditBuf({ body: ticket.body || '' })}
                    title="Edit body"
                  >
                    Edit
                  </button>
                </div>
              </div>

              {/* ── Body — read (TdAnnotate) or edit (TKT-0233: body-only) ── */}
              <div className="td-body-area">
                {editBuf ? (
                  <div className="td-edit">
                    <textarea
                      className="td-edit-body orch-modal-textarea"
                      rows={8}
                      value={editBuf.body}
                      onChange={(e) => setEditBuf({ ...editBuf, body: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditBuf(null); } }}
                      placeholder="Body (Markdown) — plain text auto-wraps into paragraphs"
                    />
                    <div className="td-edit-actions">
                      <button className="orch-btn ghost" onClick={() => setEditBuf(null)} disabled={saving}>Cancel</button>
                      <button className="orch-btn primary" onClick={onSaveEdit} disabled={saving}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : ticket.body ? (
                  <TdAnnotate
                    body={ticket.body}
                    comments={comments}
                    currentAuthor="you"
                    onCreate={onAddComment}
                    onUpdate={onUpdateComment}
                    onReply={onReplyComment}
                    containerSelector={containerSelector}
                  />
                ) : (
                  <div className="td-body-empty">No description.</div>
                )}
              </div>

              {/* TKT-0284: spec → work-items panel. Specs surface their children
                  (work items with parent_id = this spec) as a clickable list
                  under the body, aligned to the 1200px column. Children are
                  read LIVE from the store so a newly-created work item appears
                  instantly (its creation broadcasts ticket-created, not a
                  parent refresh). Non-spec tickets skip the panel v1. */}
              {ticket.kind === 'spec' && (
                <SpecChildrenPanel
                  specId={ticket.id}
                  projectContractId={ticket.project_id}
                  resolveAssignee={resolveActor}
                />
              )}
              </div>{/* /.td-main */}
              </div>{/* /.td-layout */}
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
            ) : null}
          </>
        )}
      </Shell>
    </>
  );
}

function tdAgo(iso) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return window.SubstrateFmt?.fmtTimeAgo?.(t) || '';
}

// TKT-0284: spec → work-items panel. Renders the spec's children (work items
// with parent_id = this spec) as a clickable list, aligned to the 1200px
// document column like .td-props. Children are read LIVE from the store on
// every render (useStore re-renders on store changes, so a newly-created work
// item appears instantly — its creation broadcasts ticket-created, not a
// parent ticket-updated, so the server's ticket.children would go stale
// without a re-fetch). "+ Work item" opens the composer with Kind=work-item
// + Parent=this spec (Router.openComposer presets).
function SpecChildrenPanel({ specId, projectContractId, resolveAssignee }) {
  useStore();
  // No memo: the store Map mutates in place on upsert (applyTicketCreated /
  // applyTicketUpdated do .set on the same Map ref), so a useMemo keyed on the
  // Map would not recompute. Recompute on every render instead — cheap at v1
  // spec volume, and useStore guarantees a re-render on every store change.
  const all = window.Store.getState().trackerTickets;
  const children = [];
  for (const t of all.values()) {
    if (t.parent_id === specId) children.push(t);
  }
  children.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const onNewWorkItem = () => {
    window.Router.openComposer(projectContractId, { kind: 'work-item', parent: specId });
  };
  return (
    <div className="td-children">
      <div className="td-children-header">
        <span className="td-children-title">Work items</span>
        <span className="td-children-count tnum">{children.length}</span>
        <button className="orch-btn small ghost td-children-add" onClick={onNewWorkItem}
          title="Create a work item under this spec">+ Work item</button>
      </div>
      {children.length === 0 ? (
        <div className="td-children-empty">No work items yet — they'll emerge as sections lock in.</div>
      ) : (
        <div className="td-children-list">
          {children.map((c) => (
            <a key={c.id}
              className="td-child-row"
              href={window.Router.buildHref({ kind: 'ticket', id: c.id })}
              onClick={(e) => { e.preventDefault(); window.Router.openTicket(c.id); }}
              title={c.title}
            >
              <span className="td-child-id mono">{c.id}</span>
              <span className="td-child-title">{c.title}</span>
              <span className={`pill ${TD_STATE_PILL[c.state] || 'idle'}`}>{c.state}</span>
              <span className="td-child-assignee">{resolveAssignee(c.assignee, c.assignee_label)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// TKT-0233: the unused TdField component was removed (fields now use .td-prop).

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
  // TKT-0204: brief "posted ✓" indicator so the user sees the result of
  // their post. The user reported "I did write an answer and try to
  // post the answer, nothing happened" — the action did work, but the
  // textarea clearing + a new comment in the rail was easy to miss.
  // This makes the success explicit.
  const [postedFlash, setPostedFlash] = React.useState(false);
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
      setPostedFlash(true);
      setTimeout(() => setPostedFlash(false), 2200);
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
      <div className="td-qr-help">
        The asker is blocked on your answer. Post below, then optionally
        re-dispatch the question back to a live session so they can resume.
      </div>
      <textarea
        ref={taRef}
        className="ceo-composer-input td-qr-input"
        rows={2}
        placeholder="Write your answer…  (⌘/Ctrl + Enter posts the answer)"
        value={text}
        onChange={(e) => { setText(e.target.value); setPostedFlash(false); }}
        onKeyDown={onKey}
        disabled={disabled}
      />
      {postedFlash && <div className="td-qr-posted">Answer posted ✓</div>}
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

window.TicketDrawer = TicketDrawer;
