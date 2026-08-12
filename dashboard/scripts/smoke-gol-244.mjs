#!/usr/bin/env node
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { trackerDbPath } from '../../lib/golem-home.js';

const BASE = process.env.GOLEM_DASHBOARD_URL || 'http://127.0.0.1:7420';
const PROJECT = process.env.GOLEM_SMOKE_PROJECT || 'golem-1eba80';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertNoTkt(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert(!/TKT-\d+/i.test(text), `${label} contains TKT ref: ${text}`);
}

function displayRef(ticket) {
  return ticket.display_id || ticket.id;
}

async function main() {
  await request('GET', '/api/health');
  const sessions = await request('GET', `/api/sessions/dispatchable?project=${encodeURIComponent(PROJECT)}`);
  const live = sessions.find((s) => s.reachable && s.status === 'idle') || sessions.find((s) => s.reachable);
  assert(live, `no reachable dispatch target for ${PROJECT}`);

  const stamp = Date.now();
  const created = [];
  const queuedIds = [];
  try {
    const work = await request('POST', '/api/tickets', {
      project_id: PROJECT,
      kind: 'task',
      title: `GOL-244 smoke work ${stamp}`,
      body: 'REST display-id route smoke.',
      created_by: 'smoke:gol-244',
    });
    created.push(work);
    const workRef = displayRef(work);
    assert(/^GOL-\d+$/.test(workRef), `created ticket missing display id: ${JSON.stringify(work)}`);

    const gotByGol = await request('GET', `/api/tickets/${encodeURIComponent(workRef)}`);
    const gotByTkt = await request('GET', `/api/tickets/${encodeURIComponent(work.id)}`);
    assert(gotByGol.id === work.id, 'GET by GOL did not resolve canonical ticket');
    assert(gotByTkt.display_id === workRef, 'legacy GET by TKT did not resolve display ticket');

    const patchedByGol = await request('PATCH', `/api/tickets/${encodeURIComponent(workRef)}`, {
      priority: 'P2',
      actor: 'smoke:gol-244',
    });
    assert(patchedByGol.priority === 'P2', 'PATCH by GOL did not update ticket');

    const patchedByTkt = await request('PATCH', `/api/tickets/${encodeURIComponent(work.id)}`, {
      priority: null,
      actor: 'smoke:gol-244',
    });
    assert(patchedByTkt.display_id === workRef, 'legacy PATCH by TKT did not resolve ticket');

    const comment = await request('POST', `/api/tickets/${encodeURIComponent(workRef)}/comments`, {
      author: 'smoke:gol-244',
      body: 'comment via display id',
      tag: 'confirmed',
    });
    assert(comment.ticket_id === workRef, `comment response ticket_id not display id: ${JSON.stringify(comment)}`);
    assertNoTkt(comment, 'comment response');

    const reply = await request('POST', `/api/tickets/${encodeURIComponent(workRef)}/comments/${encodeURIComponent(comment.id)}/reply`, {
      author: 'smoke:gol-244',
      body: 'reply via display id',
    });
    assert(reply.ticket_id === workRef, `reply response ticket_id not display id: ${JSON.stringify(reply)}`);
    assertNoTkt(reply, 'reply response');

    const linked = await request('POST', '/api/tickets', {
      project_id: PROJECT,
      kind: 'task',
      title: `GOL-244 smoke linked ${stamp}`,
      body: 'linked REST display-id route smoke.',
      created_by: 'smoke:gol-244',
    });
    created.push(linked);
    const link = await request('POST', `/api/tickets/${encodeURIComponent(workRef)}/links`, {
      to_ticket: displayRef(linked),
      type: 'relates',
    });
    assert(link.from_ticket === workRef && link.to_ticket === displayRef(linked), `link response not display ids: ${JSON.stringify(link)}`);
    assertNoTkt(link, 'link response');

    const spec = await request('POST', '/api/tickets', {
      project_id: PROJECT,
      kind: 'spec',
      title: `GOL-244 smoke spec ${stamp}`,
      body: 'Spec dispatch display-id route smoke.',
      created_by: 'smoke:gol-244',
    });
    created.push(spec);
    const specRef = displayRef(spec);

    await request('POST', `/api/tickets/${encodeURIComponent(workRef)}/dispatch`, {
      session_id: live.session_id,
      note: `GOL-244 smoke normal ${stamp}`,
      mode: 'now',
    });
    await request('POST', `/api/tickets/${encodeURIComponent(specRef)}/dispatch`, {
      session_id: live.session_id,
      note: `GOL-244 smoke spec ${stamp}`,
      mode: 'now',
    });

    const queued = await request('POST', `/api/tickets/${encodeURIComponent(specRef)}/dispatch`, {
      session_id: `offline-gol-244-${stamp}`,
      note: `GOL-244 smoke queued ${stamp}`,
      mode: 'when_idle',
    });
    assert(queued.queued === true, `when_idle offline dispatch did not queue: ${JSON.stringify(queued)}`);
    if (queued.queue_id) queuedIds.push(queued.queue_id);

    const chat = await request('GET', '/api/chat');
    const messages = Array.isArray(chat) ? chat : (chat.messages || []);
    const chatText = JSON.stringify(messages);
    const relevant = messages.filter((m) => String(m.text || m.body || '').includes(String(stamp)));
    assert(relevant.length >= 2, `did not find direct dispatch briefs in chat for ${stamp}`);
    for (const msg of relevant) assertNoTkt(msg, `chat dispatch message ${msg.id || ''}`);
    assertNoTkt(chatText.match(new RegExp(`.{0,120}${stamp}.{0,120}`, 'g')) || [], 'chat snippets');

    const indexSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
    assert(indexSource.includes('const id = ticket.display_id || ticket.id'), 'buildDispatchBrief source is not display-id-first');
    const drainerSource = readFileSync(new URL('../server/dispatch-queue.js', import.meta.url), 'utf8');
    assert(drainerSource.includes('buildDispatchBrief(ticket, row.note)'), 'dispatch drainer no longer shares buildDispatchBrief');

    const db = new Database(trackerDbPath(), { readonly: true });
    const pending = db.prepare('SELECT ticket_id, session_id, status FROM dispatch_queue WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1').get(spec.id);
    db.close();
    assert(pending?.status === 'pending', `queued row missing/prematurely delivered: ${JSON.stringify(pending)}`);

    console.log(JSON.stringify({
      ok: true,
      dashboard: BASE,
      project: PROJECT,
      dispatch_target: live.label || live.session_id,
      tickets: created.map((t) => ({ id: t.id, display_id: t.display_id })),
      rest_boundary: 'REST still returns canonical id plus display_id; agent-visible MCP masks id to display_id.',
      assertions: [
        'GET/PATCH/comment/reply/link/dispatch accepted GOL ids',
        'legacy TKT GET/PATCH still resolved',
        'comment/reply/link responses emitted display ids for ticket refs',
        'direct normal/spec dispatch chat messages contained no TKT refs',
        'offline when_idle dispatch queued through the shared buildDispatchBrief drainer path',
      ],
    }, null, 2));
  } finally {
    await Promise.all(queuedIds.map((id) => request('DELETE', `/api/dispatch-queue/${encodeURIComponent(id)}`).catch(() => {})));
    await Promise.all(created.map((t) => request('PATCH', `/api/tickets/${encodeURIComponent(displayRef(t))}`, {
      state: 'archived',
      actor: 'smoke:gol-244-cleanup',
    }).catch(() => {})));
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
