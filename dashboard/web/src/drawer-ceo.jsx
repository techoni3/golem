// CEO chat drawer — slides in from the right when the orchestrator rail is
// clicked. Renders the chat lane (user briefs + CEO acks/responses + system
// events) with a compose box pinned at the bottom and the gate-row list
// underneath the header. Reuses .drawer-* styles from styles.css.

const { useState, useEffect, useRef, useCallback } = React;

function CeoChatDrawer() {
  useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const orch = window.Store.getOrchestrator();
  const messages = window.Store.getChat();
  const ceo = orch?.ceo;
  const gates = (orch?.gates ?? []).filter(g => g.status === 'awaiting');

  useEffect(() => {
    const opener = () => setOpen(true);
    window.addEventListener('open-ceo-drawer', opener);
    return () => window.removeEventListener('open-ceo-drawer', opener);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const pushToast = (text, kind = 'ok') => {
    setToast({ text, kind, id: Math.random() });
    setTimeout(() => setToast(null), 3000);
  };

  const send = useCallback(async (fn, label) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.error(`${label} failed`, err);
      pushToast(`${label} failed: ${err?.message ?? 'channel unreachable'}`, 'err');
    } finally {
      setBusy(false);
    }
  }, []);

  const onSubmit = useCallback((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    return send(() => window.SubstrateAPI.pushBrief(trimmed), 'Brief');
  }, [send]);

  const onHalt = useCallback(() => {
    if (!confirm('Send a halt request to the CEO? It will gracefully yield after the current dispatch.')) return;
    send(() => window.SubstrateAPI.pushHalt('Halt requested from dashboard'), 'Halt');
  }, [send]);

  const onGateDecision = useCallback((gateId, decision) => {
    send(() => window.SubstrateAPI.pushGate(gateId, decision, ''), `Gate ${decision}`);
  }, [send]);

  let statusLabel, statusClass;
  if (!ceo) { statusLabel = 'No session'; statusClass = 'offline'; }
  else if (ceo.live) { statusLabel = 'Live'; statusClass = 'live'; }
  else { statusLabel = `Idle · ${fmtAge(ceo.age_ms)}`; statusClass = 'idle'; }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)}/>
      <aside className={`drawer ${open ? 'open' : ''} drawer-ceo`}>
        <div className="drawer-header">
          <div className="drawer-title-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`orch-dot ${statusClass}`}/>
              <h2 className="drawer-title">CEO</h2>
              <span className="drawer-status-pill">{statusLabel}</span>
            </div>
            <button className="drawer-close" onClick={() => setOpen(false)}><Icon.Close/></button>
          </div>
          <div className="drawer-meta">
            {ceo && (
              <div className="drawer-meta-item" title={ceo.session_id}>
                <span className="drawer-meta-key">session</span>
                <span className="drawer-meta-val mono">{ceo.session_id.slice(0, 12)}</span>
              </div>
            )}
            <div className="drawer-meta-item">
              <span className="drawer-meta-key">gates</span>
              <span className="drawer-meta-val">{gates.length} awaiting</span>
            </div>
            <button className="orch-btn small" disabled={busy || !ceo?.live} onClick={onHalt} title={!ceo?.live ? 'no live CEO session to halt' : 'halt current journey'}>
              Halt
            </button>
          </div>
        </div>

        {gates.length > 0 && (
          <div className="ceo-gates">
            {gates.slice(0, 3).map(g => (
              <div className="ceo-gate-row" key={g.gate_id}>
                <div className="ceo-gate-meta">
                  <span className="orch-gate-badge">gate</span>
                  <span className="orch-gate-flow">
                    {g.phase_just_completed || '?'} <span style={{color:'var(--text-4)'}}>→</span> {g.next_phase || '?'}
                  </span>
                  <span className="orch-gate-id mono" title={g.gate_id}>{g.gate_id}</span>
                </div>
                <div className="ceo-gate-actions">
                  <button className="orch-btn small ok"   disabled={busy} onClick={() => onGateDecision(g.gate_id, 'approve')}>Approve</button>
                  <button className="orch-btn small"      disabled={busy} onClick={() => onGateDecision(g.gate_id, 'deny')}>Deny</button>
                  <button className="orch-btn small ghost" disabled={busy} onClick={() => onGateDecision(g.gate_id, 'cancel')}>Cancel</button>
                </div>
              </div>
            ))}
            {gates.length > 3 && (
              <div className="ceo-gate-more">+{gates.length - 3} more awaiting</div>
            )}
          </div>
        )}

        <ChatLane messages={messages}/>

        <Composer onSubmit={onSubmit} busy={busy}/>

        {toast && (
          <div className={`orch-toast ${toast.kind} drawer-toast`} key={toast.id}>{toast.text}</div>
        )}
      </aside>
    </>
  );
}

function ChatLane({ messages }) {
  const ref = useRef(null);
  const stickToBottom = useRef(true);

  // Detect if the user has scrolled away from the bottom; if so stop autoscroll.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (!messages.length) {
    return (
      <div className="ceo-chat-empty">
        <div>No conversation yet.</div>
        <div className="ceo-chat-empty-hint">
          Send a brief below. The CEO will <span className="mono">ack</span> on receipt and may follow with a <span className="mono">respond</span> message for chat-style answers.
        </div>
      </div>
    );
  }

  return (
    <div className="ceo-chat" ref={ref} onScroll={onScroll}>
      {messages.map((m) => <ChatBubble key={m.id} m={m}/>)}
    </div>
  );
}

function ChatBubble({ m }) {
  const cls = `ceo-msg role-${m.role} kind-${m.kind}`;
  const ts = window.SubstrateFmt?.fmtClock?.(m.ts) || '';

  // Ack messages render as a trace line (think: "thinking" trace in agent UIs),
  // not as a full chat bubble. Plain text, no markdown.
  if (m.kind === 'ack') {
    return (
      <div className={cls}>
        <span className="ceo-msg-trace-body">{m.text}</span>
        <span className="ceo-msg-trace-ts">{ts}</span>
      </div>
    );
  }

  // CEO substantive messages render as markdown. User + system text stays plain
  // (user text is just what they typed; system events are short labels).
  const renderMarkdown = m.role === 'ceo' && m.kind === 'response' && window.marked;
  const label = labelFor(m);
  return (
    <div className={cls}>
      <div className="ceo-msg-head">
        <span className="ceo-msg-label">{label}</span>
        <span className="ceo-msg-ts">{ts}</span>
      </div>
      {renderMarkdown ? (
        <div
          className="ceo-msg-body markdown"
          dangerouslySetInnerHTML={{ __html: renderMd(m.text) }}
        />
      ) : (
        <div className="ceo-msg-body">{m.text}</div>
      )}
    </div>
  );
}

// One-time marked config: GFM (tables, fences, autolinks), no hard line breaks.
// The dashboard is single-user / localhost-only; CEO output is trusted so we
// don't bolt on DOMPurify. If that ever changes (remote channel sources push
// into the chat), wrap this in a sanitiser.
let mdConfigured = false;
function renderMd(text) {
  if (!window.marked) return text;
  if (!mdConfigured) {
    window.marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
    mdConfigured = true;
  }
  return window.marked.parse(text ?? '');
}

function labelFor(m) {
  if (m.role === 'user') return m.kind === 'interrupt' ? 'you · interrupt' : 'you';
  if (m.role === 'ceo')  return m.kind === 'ack' ? 'ceo · ack' : 'ceo';
  if (m.role === 'system') {
    if (m.kind === 'halt') return 'system · halt';
    if (m.kind?.startsWith('gate_')) return `system · ${m.kind.replace('_', ' ')}`;
    return 'system';
  }
  return m.role;
}

function Composer({ onSubmit, busy }) {
  const [text, setText] = useState('');
  const taRef = useRef(null);

  const submit = useCallback(async () => {
    if (busy) return;
    const t = text.trim();
    if (!t) return;
    await onSubmit(t);
    setText('');
    taRef.current?.focus();
  }, [busy, onSubmit, text]);

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="ceo-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={taRef}
        className="ceo-composer-input"
        rows={3}
        placeholder="Send a brief, status question, or interrupt to the CEO…  (⌘/Ctrl + Enter to send)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={busy}
      />
      <button type="submit" className="orch-btn primary" disabled={busy || !text.trim()}>
        Send
      </button>
    </form>
  );
}

function fmtAge(ms) {
  if (ms == null) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

window.CeoChatDrawer = CeoChatDrawer;
