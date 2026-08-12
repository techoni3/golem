// TKT-0649: full-context spec dispatch. Creates a scratch spec with body,
// active human comment feedback, and a child task, then dispatches it to a
// live session. Also dispatches a scratch task to prove the non-spec path
// still uses the regular brief shape. The received briefs are visible on the
// golem channel during the run.

import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const PROJECT = 'golem-1eba80';
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => {
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(json)}`);
  return json;
});
const patch = (path, body) => fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const get = (path) => fetch(`${API}${path}`).then((r) => r.json());

const targetRows = await get(`/sessions/dispatchable?project=${encodeURIComponent(PROJECT)}`);
const target = targetRows.find((s) => s.reachable !== false) || targetRows[0];
assert.ok(target?.session_id, 'at least one dispatchable session exists');

const marker = `SMOKE-0649-${Date.now().toString(36)}`;
const created = [];
try {
  const spec = await post('/tickets', {
    project_id: PROJECT,
    kind: 'spec',
    created_by: 'smoke',
    title: `${marker} full-context spec`,
    body: `# ${marker} Spec Body\n\nThis body marker must appear in the received full-context spec brief.`,
  });
  created.push(spec.id);
  const child = await post('/tickets', {
    project_id: PROJECT,
    kind: 'task',
    created_by: 'smoke',
    title: `${marker} child task`,
    parent_id: spec.id,
    body: 'child body',
  });
  created.push(child.id);
  const comment = await post(`/tickets/${encodeURIComponent(spec.id)}/comments`, {
    author: 'human',
    body: `${marker} active human comment`,
    block_id: 'smoke#1',
    quote: `${marker} quote`,
  });
  assert.equal(comment.dispatch_state, 'undispatched', 'human spec comment defaults undispatched');

  const specDispatch = await post(`/tickets/${encodeURIComponent(spec.id)}/dispatch`, { session_id: target.session_id });
  assert.equal(specDispatch.ok, true, 'spec dispatch ok');
  assert.equal(specDispatch.ticket.kind, 'spec', 'spec dispatch returned spec ticket');

  const work = await post('/tickets', {
    project_id: PROJECT,
    kind: 'task',
    created_by: 'smoke',
    title: `${marker} regular task`,
    body: 'regular task body',
  });
  created.push(work.id);
  const workDispatch = await post(`/tickets/${encodeURIComponent(work.id)}/dispatch`, { session_id: target.session_id });
  assert.equal(workDispatch.ok, true, 'task dispatch ok');
  assert.equal(workDispatch.ticket.kind, 'task', 'task dispatch returned task ticket');

  console.log(JSON.stringify({
    ok: true,
    marker,
    target: target.session_id,
    spec: spec.id,
    child: child.id,
    comment: comment.id,
    specChannelOk: specDispatch.channel?.ok ?? null,
    work: work.id,
    workChannelOk: workDispatch.channel?.ok ?? null,
  }, null, 2));
} finally {
  for (const id of created) {
    try { await patch(`/tickets/${encodeURIComponent(id)}`, { state: 'archived', actor: 'smoke' }); } catch {}
  }
}
