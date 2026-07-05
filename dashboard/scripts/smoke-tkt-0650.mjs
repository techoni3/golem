// TKT-0650: wave-aware dispatch drainer. Uses a temp tracker DB plus fake idle
// sessions/channels so the assertions are deterministic and do not depend on
// live Claude session status.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTrackerDb } from '../server/tracker-db.js';
import { initDispatchDrainer } from '../server/dispatch-queue.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-tkt0650-'));
const tracker = openTrackerDb(path.join(tmp, 'tracker.db'));
const delivered = [];
const chats = [];
const ws = [];
const sessions = [
  { session_id: 'ses_wave', alive: true, status: 'idle' },
  { session_id: 'ses_free', alive: true, status: 'idle' },
];

const state = { nativeSessions: () => sessions };
const chat = { record: (role, kind, text, meta) => chats.push({ role, kind, text, meta }) };
const pushBrief = async (brief, sessionId) => {
  delivered.push({ brief, sessionId });
  return { ok: true, status: 200 };
};
const listChannels = async () => sessions.map((s) => ({ session_id: s.session_id }));
const broadcastWS = (msg) => ws.push(msg);
const buildDispatchBrief = (ticket) => `brief:${ticket.id}:${ticket.title}`;

try {
  const spec = tracker.createTicket({ project_id: 'golem-1eba80', kind: 'spec', title: 'SMOKE-0650 spec', created_by: 'smoke' });
  const w1 = tracker.createTicket({ project_id: 'golem-1eba80', kind: 'work-item', title: 'SMOKE-0650 W1', parent_id: spec.id, wave: 1, created_by: 'smoke' });
  const w2 = tracker.createTicket({ project_id: 'golem-1eba80', kind: 'work-item', title: 'SMOKE-0650 W2', parent_id: spec.id, wave: 2, created_by: 'smoke' });
  const free = tracker.createTicket({ project_id: 'golem-1eba80', kind: 'work-item', title: 'SMOKE-0650 non-wave', created_by: 'smoke' });

  const heldRow = tracker.queueDispatch(w2.id, { session_id: 'ses_wave', actor: 'smoke' });
  const freeRow = tracker.queueDispatch(free.id, { session_id: 'ses_free', actor: 'smoke' });
  // Make the held row look very old: wave-held rows must not expire as offline.
  tracker.raw().prepare("UPDATE dispatch_queue SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(heldRow.id);

  const drainer = initDispatchDrainer({ tracker, state, chat, pushBrief, buildDispatchBrief, broadcastWS, listChannels });
  await wait(5600);

  assert.equal(delivered.some((d) => d.brief.includes(w2.id)), false, 'wave-2 child is held while wave-1 sibling is open');
  assert.equal(delivered.some((d) => d.brief.includes(free.id)), true, 'non-wave queued ticket delivers normally');
  assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(heldRow.id).status, 'pending', 'wave-held row remains pending');
  assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(freeRow.id).status, 'delivered', 'non-wave row is delivered');
  assert.ok(chats.some((c) => /wave-held/.test(c.text)), 'wave hold is logged');
  assert.ok(ws.some((m) => m.type === 'dispatch-queue-updated'), 'wave hold emits queue update delta');

  tracker.updateTicket(w1.id, { state: 'done', actor: 'smoke' });
  await wait(5600);

  assert.equal(delivered.some((d) => d.brief.includes(w2.id)), true, 'wave-2 child releases after wave-1 closes');
  assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(heldRow.id).status, 'delivered', 'released wave row is delivered');

  drainer.close();
  console.log(JSON.stringify({
    ok: true,
    spec: spec.id,
    wave1: w1.id,
    wave2: w2.id,
    heldRow: { id: heldRow.id, before: 'pending', after: 'delivered' },
    nonWave: { id: free.id, queue: freeRow.id, status: 'delivered' },
    delivered: delivered.map((d) => ({ sessionId: d.sessionId, brief: d.brief })),
    waveHoldLog: chats.find((c) => /wave-held/.test(c.text))?.text,
    queueUpdates: ws.filter((m) => m.type === 'dispatch-queue-updated').length,
  }, null, 2));
} finally {
  try { tracker.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
