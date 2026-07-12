// GOL-425: a small, factual drill-down for durable message envelopes. This is
// intentionally an Agents overlay, not another project surface: the backend
// derives every row from durable delivery/acknowledgement facts on each read.

const COMMUNICATION_FILTERS = [
  { id: 'needs_attention', label: 'Needs attention' },
  { id: 'in_flight', label: 'In flight' },
  { id: 'history', label: 'History' },
];

function communicationWhen(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return value || '—';
  return window.SubstrateFmt?.fmtClock?.(ms) || new Date(ms).toLocaleString();
}

function communicationSeverityLabel(item) {
  if (item.dismissed) return 'dismissed';
  if (item.needs_attention) return 'needs attention';
  if (item.queued) return 'queued';
  return ({ awaiting: 'awaiting acknowledgement', pinged: 'reminder sent', failed: 'delivery failed', escalated: 'escalated', healthy: 'complete' })[item.severity] || item.severity;
}

function CommunicationEnvelopeRow({ item, onDismiss }) {
  const ticketHref = item.ticket_id ? window.Router.buildHref({ kind: 'ticket', id: item.ticket_id }) : null;
  const sessionHref = item.session_id ? `${window.Router.buildHref({ kind: 'agents' })}?ns=${encodeURIComponent(item.session_id)}` : null;
  const openTicket = (event) => {
    event.preventDefault();
    if (item.ticket_id) window.Router.openTicket(item.ticket_id);
  };
  const openSession = (event) => {
    event.preventDefault();
    if (item.session_id) window.Router.openNativeSession(item.session_id);
  };
  return (
    <article className={`communication-envelope severity-${item.severity} ${item.needs_attention ? 'needs-attention' : ''}`} data-envelope-id={item.id}>
      <div className="communication-envelope-head">
        <span className={`communication-severity-dot severity-${item.severity}`}/>
        <span className={`communication-state severity-${item.severity}`}>{communicationSeverityLabel(item)}</span>
        {item.needs_attention && item.ticket_id && (
          <button
            type="button"
            className="communication-dismiss"
            data-testid="communication-dismiss"
            title="Dismiss this attention item; its envelope evidence stays in History"
            onClick={() => onDismiss(item)}
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="communication-envelope-links">
        {ticketHref ? (
          <a className="communication-ticket-link mono" data-testid="communication-ticket-link" href={ticketHref} onClick={openTicket} title={item.ticket_title || item.ticket_display_id}>
            {item.ticket_display_id || item.ticket_id}
          </a>
        ) : <span className="mono">notification</span>}
        {item.ticket_title && <span className="communication-ticket-title">{item.ticket_title}</span>}
        {sessionHref && (
          <a className="communication-session-link mono" data-testid="communication-session-link" href={sessionHref} onClick={openSession} title={item.session_id}>
            to {item.session_label || item.session_id}
          </a>
        )}
      </div>
      <ol className="communication-facts" aria-label={`Envelope evidence for ${item.ticket_display_id || item.id}`}>
        {(item.facts || []).map((fact, index) => (
          <li key={`${fact.kind}-${fact.at}-${index}`} className={`communication-fact${fact.severity ? ` severity-${fact.severity}` : ''}`}>
            <span className="communication-fact-time mono">{communicationWhen(fact.at)}</span>
            <span className="communication-fact-label">{fact.label}</span>
            {fact.detail && <span className="communication-fact-detail">{fact.detail}</span>}
          </li>
        ))}
      </ol>
    </article>
  );
}

function CommunicationDrawer({ open, onClose }) {
  useStore();
  const communicationHealthRev = window.Store.getState().communicationHealthRev || 0;
  const [filter, setFilter] = React.useState('needs_attention');
  const [items, setItems] = React.useState([]);
  const [summary, setSummary] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => {
    if (!open) return () => {};
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.SubstrateAPI.listMessageEnvelopes({ state: filter }),
      window.SubstrateAPI.communicationHealth(),
    ]).then(([list, health]) => {
      if (cancelled) return;
      setItems(Array.isArray(list?.items) ? list.items : []);
      setSummary(health?.health || null);
    }).catch((err) => {
      if (!cancelled) {
        setItems([]);
        setError(err?.message || 'Unable to load communication health');
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, filter, communicationHealthRev]);

  React.useEffect(() => load(), [load]);
  const dismiss = (item) => {
    if (!item?.ticket_id || !item?.id) return;
    // Do not optimistically erase facts. The existing dismissal endpoint emits
    // a WS invalidation, and this drawer re-queries the derived result once.
    window.SubstrateAPI.dismissUnackedDispatch(item.ticket_id, item.id)
      .catch((err) => setError(err?.payload?.error || err?.message || 'Dismissal failed'));
  };
  const count = summary?.needs_attention || 0;

  return (
    <>
      <DrawerBackdrop open={open} onClose={onClose}/>
      <DrawerPanel open={open} onClose={onClose} label="Communication health" className="communication-drawer" data-testid="communication-drawer">
        <div className="drawer-header communication-drawer-header">
          <div className="drawer-title-row">
            <span className={`communication-severity-dot severity-${summary?.level || 'green'}`}/>
            <div>
              <h2 className="drawer-title">Communication health</h2>
              <div className="communication-drawer-subtitle">{count ? `${count} derived needs-you item${count === 1 ? '' : 's'}` : 'Envelope facts only; no stored attention state.'}</div>
            </div>
            <button type="button" className="drawer-close" aria-label="Close communication health" onClick={onClose}>×</button>
          </div>
          <div className="communication-filter-tabs" role="tablist" aria-label="Communication timeline filter">
            {COMMUNICATION_FILTERS.map((option) => (
              <button
                type="button"
                key={option.id}
                role="tab"
                aria-selected={filter === option.id}
                className={`communication-filter-tab ${filter === option.id ? 'active' : ''}`}
                data-testid={`communication-filter-${option.id}`}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="communication-drawer-body">
          {loading && <div className="communication-empty">Loading envelope facts…</div>}
          {!loading && error && <div className="communication-error">{error}</div>}
          {!loading && !error && items.length === 0 && <div className="communication-empty" data-testid="communication-empty">No {COMMUNICATION_FILTERS.find((option) => option.id === filter)?.label.toLowerCase()} envelopes.</div>}
          {!loading && !error && items.map((item) => <CommunicationEnvelopeRow key={item.id} item={item} onDismiss={dismiss}/>) }
        </div>
      </DrawerPanel>
    </>
  );
}

function openCommunicationDrawer() {
  window.Router.openOverlay('communication', '1');
}

window.CommunicationDrawer = CommunicationDrawer;
window.openCommunicationDrawer = openCommunicationDrawer;
