// TKT-0244: a comment PATCH must NOT wipe the body when `body` is omitted.
// REST-only smoke (the bug is server-side). Creates a ticket + a comment with a
// non-empty body, then PATCHes {status}, {tag}, {block_id} in turn and asserts
// the body survives each (status/tag/block_id update correctly); finally
// PATCHes {body:''} and asserts the body is cleared (intentional clear still
// works). On the buggy code the first status PATCH would null the body to ''.
// Archives the scratch ticket in finally.

import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const PROJECT = 'golem-1eba80';
const post = (p, body) => fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (p, body) => fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());

// A body with no 3+ blank lines + no leading/trailing whitespace so toMarkdownBody
// is the identity here (the stored body === BODY).
const BODY = 'This is the comment body — it must survive status/tag/block_id PATCHes. Unique token: kookaburra-0244.';

let ticketId = null, commentId = null;
try {
  ticketId = (await post('/tickets', { project_id: PROJECT, kind: 'task', created_by: 'smoke', title: 'SMOKE-0244 comment-patch', body: 'scratch' })).id;
  assert.ok(ticketId, 'created scratch ticket');
  const c = await post(`/tickets/${encodeURIComponent(ticketId)}/comments`, { author: 'smoke', body: BODY, tag: 'note' });
  commentId = c.id;
  assert.ok(commentId, 'created comment');

  const fetchComment = async () => {
    const t = await get(`/tickets/${encodeURIComponent(ticketId)}`);
    return (t.comments || []).find((x) => x.id === commentId) || null;
  };

  // 1. PATCH {status:'resolved'} → body UNCHANGED, status resolved
  await patch(`/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`, { status: 'resolved' });
  let cm = await fetchComment();
  assert.ok(cm, 'comment present after status PATCH');
  assert.equal(cm.status, 'resolved', `status PATCHed to resolved (got ${cm.status})`);
  assert.equal(cm.body, BODY, `body survives a status-only PATCH (got len ${cm.body?.length}, expected ${BODY.length})`);

  // 2. PATCH {tag:'fix'} → body UNCHANGED, tag fix
  await patch(`/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`, { tag: 'fix' });
  cm = await fetchComment();
  assert.equal(cm.tag, 'fix', `tag PATCHed to fix (got ${cm.tag})`);
  assert.equal(cm.body, BODY, 'body survives a tag-only PATCH');

  // 3. PATCH {block_id:'blk-0244'} → body UNCHANGED, block_id set (not null)
  await patch(`/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`, { block_id: 'blk-0244' });
  cm = await fetchComment();
  assert.equal(cm.block_id, 'blk-0244', `block_id PATCHed (got ${cm.block_id})`);
  assert.equal(cm.body, BODY, 'body survives a block_id-only PATCH');

  // 4. PATCH {body:''} → body cleared (intentional clear still works)
  await patch(`/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`, { body: '' });
  cm = await fetchComment();
  assert.equal(cm.body, '', `intentional {body:""} clears the body (got len ${cm.body?.length})`);

  console.log(JSON.stringify({ ok: true, ticketId, commentId, bodyLen: BODY.length }, null, 2));
} finally {
  if (ticketId) { try { await patch(`/tickets/${encodeURIComponent(ticketId)}`, { state: 'archived' }); } catch {} }
}