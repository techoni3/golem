// Thin proxy from the dashboard to the golem MCP channel servers.
//
// v3 multi-CEO: each CEO spawns its own channel-server child on an ephemeral
// port and registers it in ~/.config/golem/channels.json. The dashboard
// reads that registry and forwards each brief / interrupt / halt / gate to
// the correct CEO based on a session_id.
//
// If no session is specified, fall back behaviour:
//   - exactly one channel registered → forward to it (single-CEO compat).
//   - zero or 2+                       → 502 with a hint.
//
// CONFIG.channelUrl is still honoured as a legacy probe target for
// /api/channel/health, but is no longer used for brief routing.

import { CONFIG } from './config.js';
import { readChannels } from './channels.js';

const DEFAULT_TIMEOUT_MS = 5000;

async function resolveBaseUrl(sessionId) {
  const channels = await readChannels();
  if (sessionId) {
    const ch = channels.find((c) => c.session_id === sessionId);
    if (!ch) {
      return {
        baseUrl: null,
        error: `no channel registered for session ${sessionId}`,
      };
    }
    return { baseUrl: ch.url };
  }
  if (channels.length === 1) {
    return { baseUrl: channels[0].url };
  }
  if (channels.length === 0) {
    // Legacy fallback to the static config — useful when GOLEM_CHANNEL_PORT
    // is pinned to 7421 (single-CEO smoke tests) and the channel server
    // didn't (or couldn't) register itself.
    return { baseUrl: CONFIG.channelUrl };
  }
  return {
    baseUrl: null,
    error: `multiple CEO sessions live (${channels.length}); specify ?session=<session_id>`,
  };
}

async function forward(method, pathSuffix, body, sessionId) {
  const { baseUrl, error } = await resolveBaseUrl(sessionId);
  if (!baseUrl) {
    return { ok: false, status: 0, body: '', error: error ?? 'no channel available' };
  }
  const url = `${baseUrl.replace(/\/$/, '')}${pathSuffix}`;
  const headers = { 'X-Sender': 'dashboard' };
  let bodyToSend = undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      bodyToSend = body;
      headers['Content-Type'] = 'text/plain';
    } else {
      bodyToSend = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method, headers, body: bodyToSend, signal: ctl.signal });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text, target: baseUrl };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err?.message ?? err), target: baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

export async function pushBrief(body, sessionId) {
  return forward('POST', '/brief', body, sessionId);
}

export async function pushInterrupt(body, sessionId) {
  return forward('POST', '/interrupt', body, sessionId);
}

export async function pushHalt(body, sessionId) {
  return forward('POST', '/halt', body ?? 'halt requested by dashboard', sessionId);
}

export async function channelHealth(sessionId) {
  return forward('GET', '/healthz', null, sessionId);
}

// Used by /api/channel/list — exposes the live channels so the frontend can
// label tabs / pickers with their target endpoints.
export async function listChannels() {
  return readChannels();
}
