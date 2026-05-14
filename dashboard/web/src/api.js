// Browser-side REST + WebSocket client for the dashboard backend.
// Plain JS so it loads before babel-transformed JSX components.

(function () {
  const base = ''; // same-origin

  async function getJSON(path) {
    const r = await fetch(base + path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} ${path}`);
    return r.json();
  }

  async function postJSON(path, body) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body == null ? '{}' : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* response may be plain text */ }
    if (!r.ok) {
      const err = new Error(`${r.status} ${r.statusText} ${path}`);
      err.payload = json;
      throw err;
    }
    return json;
  }

  function wsUrl(path) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${path}`;
  }

  // Listener-friendly WS wrapper with auto-reconnect.
  function createWS({ url, onMessage, onStatus }) {
    let socket = null;
    let alive = true;
    let backoff = 600;
    let pingTimer = null;

    function setStatus(s) {
      try {
        onStatus && onStatus(s);
      } catch {
        /* ignore */
      }
    }

    function connect() {
      if (!alive) return;
      setStatus('connecting');
      try {
        socket = new WebSocket(url);
      } catch (err) {
        setStatus('disconnected');
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        backoff = 600;
        setStatus('connected');
        // Keep-alive pings every 25s.
        pingTimer = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({ type: 'ping' }));
            } catch {
              /* ignore */
            }
          }
        }, 25_000);
      };
      socket.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        try {
          onMessage && onMessage(msg);
        } catch (err) {
          console.error('ws onMessage error', err);
        }
      };
      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        setStatus('disconnected');
        scheduleReconnect();
      };
      socket.onerror = () => {
        // close handler will run; nothing to do here.
      };
    }

    function scheduleReconnect() {
      if (!alive) return;
      const delay = Math.min(backoff, 8000);
      setTimeout(connect, delay);
      backoff = Math.min(backoff * 1.6, 8000);
    }

    function send(obj) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(obj));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    function close() {
      alive = false;
      if (pingTimer) clearInterval(pingTimer);
      if (socket) socket.close();
    }

    connect();
    return { send, close };
  }

  window.SubstrateAPI = {
    getJSON,
    postJSON,
    wsUrl,
    createWS,
    snapshot: () => getJSON('/api/snapshot'),
    meta: () => getJSON('/api/meta'),
    projects: () => getJSON('/api/projects'),
    workspaces: () => getJSON('/api/workspaces'),
    orchestrator: () => getJSON('/api/orchestrator'),
    agents: (projectId) => getJSON(`/api/projects/${encodeURIComponent(projectId)}/agents`),
    agentDetail: (projectId, agentId) =>
      getJSON(
        `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`,
      ),
    tickets: (projectId) => getJSON(`/api/projects/${encodeURIComponent(projectId)}/tickets`),
    // Orchestrator intrusions (proxied to the golem MCP channel server).
    // sessionId routes the brief to a specific live CEO. Omit it (or pass null)
    // when there is exactly one CEO live — the server picks it up by default.
    pushBrief: (text, sessionId) =>
      postJSON('/api/brief', { brief: text, session_id: sessionId ?? null }),
    pushInterrupt: (text, sessionId) =>
      postJSON('/api/interrupt', { text, session_id: sessionId ?? null }),
    pushHalt: (reason, sessionId) =>
      postJSON('/api/halt', { reason: reason ?? '', session_id: sessionId ?? null }),
    pushGate: (gateId, decision, note, sessionId) =>
      postJSON(
        `/api/gates/${encodeURIComponent(gateId)}/${encodeURIComponent(decision)}`,
        { note: note ?? '', session_id: sessionId ?? null },
      ),
    channels: () => getJSON('/api/channels'),
    channelHealth: (sessionId) =>
      getJSON(`/api/channel/health${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
  };
})();
