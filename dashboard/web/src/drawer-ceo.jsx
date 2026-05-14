// CEO chat drawer — slides in from the right when a CEO chip on the
// orchestrator rail is clicked. Renders the chat lane (user briefs + CEO
// acks/responses + system events) filtered to the active session, with a
// compose box pinned at the bottom and the gate-row list underneath the
// header. Reuses .drawer-* styles from styles.css.
//
// v3: the drawer is keyed by a `sessionId` set via the `open-ceo-drawer`
// CustomEvent. Briefs/halts/gate verdicts include the session_id so the
// backend routes them to the correct CEO. A session selector at the top of
// the drawer lets the user switch between live CEOs without closing.

const { useState, useEffect, useRef, useCallback, useMemo } = React;

function CeoChatDrawer() {
  useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const orch = window.Store.getOrchestrator();
  const sessions = window.Store.getSessions();

  // Auto-pick the only live session when there is exactly one and none is
  // selected yet. Also re-pick when the previously-active session disappears
  // (CEO died / was unregistered).
  useEffect(() => {
    if (sessions.length === 0) {
      if (activeSessionId !== null) setActiveSessionId(null);
      return;
    }
    if (!activeSessionId || !sessions.some((s) => s.session_id === activeSessionId)) {
      setActiveSessionId(sessions[0].session_id);
    }
  }, [sessions, activeSessionId]);

  const active = useMemo(
    () => sessions.find((s) => s.session_id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const messages = window.Store.getChatForSession(activeSessionId);
  const gates = (orch?.gates ?? []).filter((g) => g.status === 'awaiting');

  useEffect(() => {
    const opener = (e) => {
      setOpen(true);
      const wanted = e?.detail?.sessionId;
      if (wanted) setActiveSessionId(wanted);
    };
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
    return send(() => window.SubstrateAPI.pushBrief(trimmed, activeSessionId), 'Brief');
  }, [send, activeSessionId]);

  const onHalt = useCallback(() => {
    if (!confirm(`Send a halt request to CEO ${activeSessionId?.slice(0, 8) ?? '?'} — gracefully yield after current dispatch?`)) return;
    send(() => window.SubstrateAPI.pushHalt('Halt requested from dashboard', activeSessionId), 'Halt');
  }, [send, activeSessionId]);

  const onGateDecision = useCallback((gateId, decision) => {
    send(() => window.SubstrateAPI.pushGate(gateId, decision, '', activeSessionId), `Gate ${decision}`);
  }, [send, activeSessionId]);

  const hasChannel = !!active?.channel_port;
  let statusLabel, statusClass;
  if (!active) { statusLabel = 'No session'; statusClass = 'offline'; }
  else if (hasChannel) { statusLabel = 'Live'; statusClass = 'live'; }
  else { statusLabel = 'No channel'; statusClass = 'idle'; }

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

          {sessions.length > 1 && (
            <div className="drawer-session-tabs">
              {sessions.map((s) => (
                <button
                  key={s.session_id}
                  className={`drawer-session-tab ${s.session_id === activeSessionId ? 'active' : ''}`}
                  onClick={() => setActiveSessionId(s.session_id)}
                  title={`session ${s.session_id} · ${s.claimed_project ?? 'unbound'}`}
                >
                  <span className="drawer-session-tab-claim">
                    {s.claimed_project ?? <span className="drawer-session-unbound">&lt;unbound&gt;</span>}
                  </span>
                  <span className="drawer-session-tab-sid mono">{s.session_id.slice(0, 8)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="drawer-meta">
            {active && (
              <>
                <div className="drawer-meta-item" title={active.session_id}>
                  <span className="drawer-meta-key">session</span>
                  <span className="drawer-meta-val mono">{active.session_id.slice(0, 12)}</span>
                </div>
                <div className="drawer-meta-item" title={active.claimed_project ?? 'unbound'}>
                  <span className="drawer-meta-key">claim</span>
                  <span className="drawer-meta-val mono">
                    {active.claimed_project ?? <span className="drawer-session-unbound">&lt;unbound&gt;</span>}
                  </span>
                </div>
                {active.channel_port && (
                  <div className="drawer-meta-item" title={`http://${active.channel_host}:${active.channel_port}`}>
                    <span className="drawer-meta-key">channel</span>
                    <span className="drawer-meta-val mono">:{active.channel_port}</span>
                  </div>
                )}
              </>
            )}
            <div className="drawer-meta-item">
              <span className="drawer-meta-key">gates</span>
              <span className="drawer-meta-val">{gates.length} awaiting</span>
            </div>
            <button
              className="orch-btn small"
              disabled={busy || !hasChannel}
              onClick={onHalt}
              title={!hasChannel ? 'no channel — cannot deliver halt' : 'halt current journey'}
            >
              Halt
            </button>
          </div>
        </div>

        {gates.length > 0 && (
          <div className="ceo-gates">
            {gates.slice(0, 3).map((g) => (
              <div className="ceo-gate-row" key={g.gate_id}>
                <div className="ceo-gate-meta">
                  <span className="orch-gate-badge">gate</span>
                  <span className="orch-gate-flow">
                    {g.phase_just_completed || '?'} <span style={{ color: 'var(--text-4)' }}>→</span> {g.next_phase || '?'}
                  </span>
                  <span className="orch-gate-id mono" title={g.gate_id}>{g.gate_id}</span>
                </div>
                <div className="ceo-gate-actions">
                  <button className="orch-btn small ok"    disabled={busy || !hasChannel} onClick={() => onGateDecision(g.gate_id, 'approve')}>Approve</button>
                  <button className="orch-btn small"       disabled={busy || !hasChannel} onClick={() => onGateDecision(g.gate_id, 'deny')}>Deny</button>
                  <button className="orch-btn small ghost" disabled={busy || !hasChannel} onClick={() => onGateDecision(g.gate_id, 'cancel')}>Cancel</button>
                </div>
              </div>
            ))}
            {gates.length > 3 && (
              <div className="ceo-gate-more">+{gates.length - 3} more awaiting</div>
            )}
          </div>
        )}

        <ChatLane messages={messages}/>

        <Composer onSubmit={onSubmit} busy={busy || !hasChannel} placeholderHint={!hasChannel ? 'No channel — start a CEO via `golem session start` to send briefs' : undefined}/>

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

  if (m.kind === 'ack') {
    return (
      <div className={cls}>
        <span className="ceo-msg-trace-body">{m.text}</span>
        <span className="ceo-msg-trace-ts">{ts}</span>
      </div>
    );
  }

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

function Composer({ onSubmit, busy, placeholderHint }) {
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

  const placeholder = placeholderHint
    ?? 'Send a brief, status question, or interrupt to the CEO…  (⌘/Ctrl + Enter to send)';

  return (
    <form className="ceo-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={taRef}
        className="ceo-composer-input"
        rows={3}
        placeholder={placeholder}
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

window.CeoChatDrawer = CeoChatDrawer;
