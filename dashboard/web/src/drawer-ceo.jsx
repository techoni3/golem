// CEO chat drawer (v4) — slides in from the right when a channel chip is clicked.
// Renders the chat lane (user briefs + CEO acks + system events)
// filtered to the active session, with a compose box pinned at the bottom.
// Gate verdicts (v3 docs/agent-notes/gates/ flow) were removed in TKT-0009.

const { useState, useEffect, useRef, useCallback, useMemo } = React;

function CeoChatDrawer({ open, sessionId, onClose }) {
  useStore();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(null);

  // v4: sessions reachable over a golem channel.
  const sessions = useMemo(() => {
    const byId = new Map();
    for (const s of window.Store.getNativeSessions()) {
      if (s.session_id) byId.set(s.session_id, s);
    }
    return window.Store.getChannels()
      .map((c) => {
        const s = byId.get(c.session_id);
        if (!s) return null;
        return { ...s, channel_url: c.url, channel_host: c.host, channel_port: c.port };
      })
      .filter(Boolean);
  });

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

  // open is URL-driven (?chat=<sid>, owned by App). When opened with a specific
  // session, select it; otherwise the default-selection effect below picks the
  // first available session.
  useEffect(() => {
    if (open && sessionId) setActiveSessionId(sessionId);
  }, [open, sessionId]);

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
    if (!confirm(`Send a halt request to session ${activeSessionId?.slice(0, 8) ?? '?'} — gracefully yield after current dispatch?`)) return;
    send(() => window.SubstrateAPI.pushHalt('Halt requested from dashboard', activeSessionId), 'Halt');
  }, [send, activeSessionId]);

  const hasChannel = !!active?.channel_port;
  let statusLabel, statusClass;
  if (!active) { statusLabel = 'No session'; statusClass = 'offline'; }
  else if (hasChannel) { statusLabel = 'Live'; statusClass = 'live'; }
  else { statusLabel = 'No channel'; statusClass = 'idle'; }

  return (
    <>
      <DrawerBackdrop open={open} onClose={onClose}/>
      <DrawerPanel open={open} onClose={onClose} label="Session conversation" className="drawer-ceo">
        <div className="drawer-header">
          <div className="drawer-title-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`orch-dot ${statusClass}`}/>
              <h2 className="drawer-title">Session</h2>
              <span className="drawer-status-pill">{statusLabel}</span>
            </div>
            <button className="drawer-close" onClick={() => onClose && onClose()}><Icon.Close/></button>
          </div>

          {sessions.length > 1 && (
            <div className="drawer-session-tabs">
              {sessions.map((s) => (
                <button
                  key={s.session_id}
                  className={`drawer-session-tab ${s.session_id === activeSessionId ? 'active' : ''}`}
                  onClick={() => setActiveSessionId(s.session_id)}
                  title={`session ${s.session_id}`}
                >
                  <span className="drawer-session-tab-claim">
                    {s.name ?? <span className="drawer-session-unbound">&lt;unnamed&gt;</span>}
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
                {active.channel_port && (
                  <div className="drawer-meta-item" title={`http://${active.channel_host}:${active.channel_port}`}>
                    <span className="drawer-meta-key">channel</span>
                    <span className="drawer-meta-val mono">:{active.channel_port}</span>
                  </div>
                )}
              </>
            )}
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

        <ChatLane messages={messages}/>

        <Composer onSubmit={onSubmit} busy={busy || !hasChannel} placeholderHint={!hasChannel ? 'No channel — start a session via `golem session start` to send briefs' : undefined}/>

        {toast && (
          <div className={`orch-toast ${toast.kind} drawer-toast`} key={toast.id}>{toast.text}</div>
        )}
      </DrawerPanel>
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

  return (
    <div className="ceo-chat" ref={ref} onScroll={onScroll}>
      {messages.length === 0 ? (
        <div className="ceo-chat-empty">No messages yet. Send a brief to start the conversation.</div>
      ) : (
        messages.map((m) => (
          <div key={m.id} className={`ceo-message ${m.role} ${m.kind}`}>
            <div className="ceo-message-meta">
              <span className="ceo-message-role">{m.role}</span>
              <span className="ceo-message-ts mono">{window.SubstrateFmt?.fmtClock?.(m.ts) || m.ts}</span>
            </div>
            <div className="ceo-message-text">{m.text}</div>
          </div>
        ))
      )}
    </div>
  );
}

function Composer({ onSubmit, busy, placeholderHint }) {
  const [text, setText] = useState('');
  const submit = useCallback(() => {
    if (!text.trim() || busy) return;
    const p = onSubmit(text);
    if (p && typeof p.then === 'function') {
      p.then(() => setText('')).catch(() => {});
    } else {
      setText('');
    }
  }, [text, busy, onSubmit]);

  return (
    <div className="ceo-composer">
      <input
        className="ceo-composer-input"
        type="text"
        value={text}
        placeholder={placeholderHint || 'Send a brief to this session…'}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <button className="orch-btn primary" disabled={busy || !text.trim()} onClick={submit}>
        Send
      </button>
    </div>
  );
}

window.CeoChatDrawer = CeoChatDrawer;
