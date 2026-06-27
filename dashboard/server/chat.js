// CEO chat surface — bridges the orchestrator panel to N golem channel
// servers, one per live CEO session.
//
// v3 multi-CEO topology:
//   - Each CEO session spawns its own channel-server child on an ephemeral
//     port and registers {session_id, host, port, pid} in
//     ~/.config/golem/channels.json.
//   - We periodically reconcile the set of channels against an open SSE
//     consumer per session_id. New sessions get a fresh SSE; vanished
//     sessions get torn down.
//   - Every message recorded into the buffer carries a `session_id` so the
//     frontend can filter chat lanes per CEO.
//
// What lives here:
//   - A ring buffer of recent chat messages (user briefs + CEO acks/responses
//     + system events like halt/gate verdicts). Cap from CONFIG.chatCap.
//   - The per-session SSE consumer pool.
//   - record() — called from the dashboard's intrusion endpoints when the
//     user pushes a brief / interrupt / halt / gate verdict, so user-side
//     messages also land in the chat lane.
//   - A simple EventEmitter so index.js can fan new messages out over the WS.
//
// Message shape:
//   {
//     id, ts, role: 'user'|'ceo'|'system',
//     kind, gate_id?, text,
//     session_id?      // CEO route key; null for system errors without target
//   }

import { EventEmitter } from 'node:events';
import { CONFIG } from './config.js';
import { readChannels } from './channels.js';

let nextId = 1;
function makeId() {
  return `m${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

export function createChat() {
  const emitter = new EventEmitter();
  /** @type {Array<object>} */
  const buffer = [];
  /** @type {Map<string, {abort: AbortController|null, reconnectTimer: any, stopped: boolean, channel: object}>} */
  const consumers = new Map();
  let pollTimer = null;
  let stopped = false;

  function push(msg) {
    const full = {
      id: msg.id || makeId(),
      ts: msg.ts || new Date().toISOString(),
      ...msg,
    };
    buffer.push(full);
    while (buffer.length > CONFIG.chatCap) buffer.shift();
    emitter.emit('message', full);
    return full;
  }

  function record(role, kind, text, extras = {}) {
    if (!text && role !== 'system') return null;
    return push({ role, kind, text: text ?? '', ...extras });
  }

  function snapshot() {
    return buffer.slice();
  }

  // ---- Per-session SSE consumer ----

  async function connectSSE(session_id, channel) {
    if (stopped) return;
    const entry = consumers.get(session_id);
    if (!entry || entry.stopped) return;
    const url = `${channel.url}/events`;
    const ctl = new AbortController();
    entry.abort = ctl;
    let resp;
    try {
      resp = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: ctl.signal,
      });
    } catch {
      if (!entry.stopped) scheduleReconnect(session_id, channel);
      return;
    }
    if (!resp.ok || !resp.body) {
      scheduleReconnect(session_id, channel);
      return;
    }
    emitter.emit('sse-connected', { session_id });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let leftover = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        leftover += decoder.decode(value, { stream: true });
        const blocks = leftover.split('\n\n');
        leftover = blocks.pop() ?? '';
        for (const block of blocks) {
          handleSseBlock(session_id, block);
        }
      }
    } catch {
      // stream broke; fall through to reconnect
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
    if (!entry.stopped) scheduleReconnect(session_id, channel);
  }

  function handleSseBlock(session_id, block) {
    if (!block.trim()) return;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }

    // Payload may include its own session_id (v3 channel server stamps it).
    // Prefer that, fall back to the registry-derived session_id we connected with.
    const sid = (typeof data.session_id === 'string' && data.session_id) || session_id;

    if (event === 'ack') {
      push({
        role: 'ceo',
        kind: 'ack',
        session_id: sid,
        text: typeof data.summary === 'string' ? data.summary : '',
        event_kind: data.kind || undefined,
        gate_id: data.gate_id || undefined,
        ts: data.ts || undefined,
      });
    } else if (event === 'response') {
      push({
        role: 'ceo',
        kind: 'response',
        session_id: sid,
        text: typeof data.text === 'string' ? data.text : '',
        event_kind: data.kind || undefined,
        gate_id: data.gate_id || undefined,
        ts: data.ts || undefined,
      });
    } else if (event === 'consult') {
      // A peer asked THIS session for a fresh pair of eyes. Log a short audit
      // marker on its lane — the full problem text stays in the session.
      push({
        role: 'system',
        kind: 'consult',
        session_id: sid,
        text:
          (data.status_ping ? '🔁 consult status-ping from ' : '🔍 consult request from ') +
          `"${data.from_name || '?'}"` +
          (data.consult_id ? ` (${data.consult_id})` : ''),
        event_kind: 'consult',
        ts: data.ts || undefined,
      });
    } else if (event === 'consult_reply') {
      push({
        role: 'system',
        kind: 'consult_reply',
        session_id: sid,
        text:
          `💡 consult reply from "${data.from_name || '?'}"` +
          (data.consult_id ? ` (${data.consult_id})` : ''),
        event_kind: 'consult_reply',
        ts: data.ts || undefined,
      });
    }
  }

  function scheduleReconnect(session_id, channel) {
    if (stopped) return;
    const entry = consumers.get(session_id);
    if (!entry || entry.stopped) return;
    if (entry.reconnectTimer) return;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      // Reconnect against the latest known channel; the channel may have
      // moved ports if the CEO restarted under the same session_id.
      const fresh = consumers.get(session_id);
      if (fresh && !fresh.stopped) connectSSE(session_id, fresh.channel);
    }, CONFIG.chatReconnectMs);
  }

  function stopConsumer(session_id) {
    const entry = consumers.get(session_id);
    if (!entry) return;
    entry.stopped = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.abort) { try { entry.abort.abort(); } catch { /* noop */ } }
    consumers.delete(session_id);
  }

  // ---- Reconciler: drive the consumer pool from the channels registry. ----

  async function reconcile() {
    if (stopped) return;
    let channels;
    try {
      channels = await readChannels();
    } catch {
      return;
    }
    const seen = new Set();
    for (const ch of channels) {
      if (!ch.session_id) continue;
      seen.add(ch.session_id);
      const existing = consumers.get(ch.session_id);
      if (!existing) {
        const entry = { abort: null, reconnectTimer: null, stopped: false, channel: ch };
        consumers.set(ch.session_id, entry);
        connectSSE(ch.session_id, ch);
      } else if (existing.channel.url !== ch.url) {
        // Same session, new port (CEO restarted). Reset.
        stopConsumer(ch.session_id);
        const entry = { abort: null, reconnectTimer: null, stopped: false, channel: ch };
        consumers.set(ch.session_id, entry);
        connectSSE(ch.session_id, ch);
      }
    }
    for (const sid of [...consumers.keys()]) {
      if (!seen.has(sid)) stopConsumer(sid);
    }
  }

  function start() {
    reconcile();
    pollTimer = setInterval(reconcile, 3000);
  }

  function stop() {
    stopped = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    for (const sid of [...consumers.keys()]) stopConsumer(sid);
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    snapshot,
    record,
    reconcile,
    start,
    stop,
  };
}
