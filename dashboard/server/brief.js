// Thin proxy from the dashboard to the golem MCP channel server.
//
// The channel server (substrate/channels/golem/index.js) runs as a child
// process of the live golem-ceo Claude Code session and exposes a localhost
// HTTP listener. The dashboard exposes a familiar REST surface to its UI and
// forwards each call to the channel server's matching endpoint, attaching
// `X-Sender: dashboard` so the channel server's allowlist accepts it.

import { CONFIG } from './config.js';

const DEFAULT_TIMEOUT_MS = 5000;

async function forward(method, pathSuffix, body) {
  const url = `${CONFIG.channelUrl.replace(/\/$/, '')}${pathSuffix}`;
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
    return { ok: resp.ok, status: resp.status, body: text };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function pushBrief(body) {
  return forward('POST', '/brief', body);
}

export async function pushInterrupt(body) {
  return forward('POST', '/interrupt', body);
}

export async function pushHalt(body) {
  return forward('POST', '/halt', body ?? 'halt requested by dashboard');
}

export async function pushGate(gateId, decision, body) {
  if (!['approve', 'deny', 'cancel'].includes(decision)) {
    throw new Error(`unknown gate decision: ${decision}`);
  }
  // gateId expected to be a stable string; allow it to contain dashes etc.
  const safe = encodeURIComponent(gateId);
  return forward('POST', `/gates/${safe}/${decision}`, body ?? '');
}

export async function channelHealth() {
  return forward('GET', '/healthz', null);
}
