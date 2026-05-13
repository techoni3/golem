// CEO chat surface — bridges the orchestrator panel to the golem channel server.
//
// What lives here:
//   - A ring buffer of recent chat messages (user briefs + CEO acks/responses
//     + system events like halt/gate verdicts). Cap from CONFIG.chatCap.
//   - An SSE consumer that connects to the channel server's GET /events and
//     records each `ack` / `response` it observes.
//   - record() — called from the dashboard's intrusion endpoints when the
//     user pushes a brief / interrupt / halt / gate verdict, so user-side
//     messages also land in the chat lane.
//   - A simple EventEmitter so index.js can fan new messages out over the WS.
//
// Message shape (all messages share these fields):
//   {
//     id: string,           // monotonic id, useful for de-dup on reconnect
//     ts: string,           // ISO timestamp
//     role: 'user' | 'ceo' | 'system',
//     kind: string,         // brief|interrupt|halt|gate_approve|...
//                           // ack|response|system
//     gate_id?: string,
//     text: string,         // human-readable body
//   }

import { EventEmitter } from 'node:events';
import { CONFIG } from './config.js';

let nextId = 1;
function makeId() {
  return `m${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

export function createChat() {
  const emitter = new EventEmitter();
  /** @type {Array<object>} */
  const buffer = [];
  let sseAbort = null;
  let reconnectTimer = null;
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

  // ---- SSE consumer ----

  async function connectSSE() {
    if (stopped) return;
    const url = `${CONFIG.channelUrl.replace(/\/$/, '')}/events`;
    const ctl = new AbortController();
    sseAbort = ctl;
    let resp;
    try {
      resp = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: ctl.signal,
      });
    } catch (err) {
      if (!stopped) scheduleReconnect();
      return;
    }
    if (!resp.ok || !resp.body) {
      scheduleReconnect();
      return;
    }
    emitter.emit('sse-connected');
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
          handleSseBlock(block);
        }
      }
    } catch {
      // stream broke; fall through to reconnect
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
    if (!stopped) scheduleReconnect();
  }

  function handleSseBlock(block) {
    if (!block.trim()) return;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment
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

    if (event === 'ack') {
      push({
        role: 'ceo',
        kind: 'ack',
        text: typeof data.summary === 'string' ? data.summary : '',
        event_kind: data.kind || undefined,
        gate_id: data.gate_id || undefined,
        ts: data.ts || undefined,
      });
    } else if (event === 'response') {
      push({
        role: 'ceo',
        kind: 'response',
        text: typeof data.text === 'string' ? data.text : '',
        event_kind: data.kind || undefined,
        gate_id: data.gate_id || undefined,
        ts: data.ts || undefined,
      });
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSSE();
    }, CONFIG.chatReconnectMs);
  }

  function start() {
    connectSSE();
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (sseAbort) {
      try { sseAbort.abort(); } catch { /* noop */ }
      sseAbort = null;
    }
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    snapshot,
    record,
    start,
    stop,
  };
}
