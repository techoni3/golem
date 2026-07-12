import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { enqueuePiBrief } from '../lib/pi-inbox.js'; import { initDispatchDrainer } from '../dashboard/server/dispatch-queue.js';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-'));
const env = { ...process.env, HOME: path.join(temp, 'home'), GOLEM_HOME: path.join(temp, 'state'), XDG_CONFIG_HOME: path.join(temp, 'xdg') };
try {
  execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'sync', '--target', 'pi'], { cwd: repo, env });
  assert.equal(fs.existsSync(path.join(env.HOME, '.pi')), false); const root = path.join(env.GOLEM_HOME, 'renders', 'pi');
  const caps = JSON.parse(fs.readFileSync(path.join(root, 'capabilities.json'))); assert.equal(caps.tier, 'B'); assert.equal(caps.push_delivery, false); assert.equal(caps.node, '>=22.19');
  assert.ok(!fs.readFileSync(path.join(root, 'golem.ts'), 'utf8').includes(repo), 'extension is portable');
  const executable = path.join(root, 'golem.mjs'); fs.copyFileSync(path.join(root, 'golem.ts'), executable);
  const handlers = {}; const extension = (await import(`file://${executable}`)).default; process.env.GOLEM_HOME = env.GOLEM_HOME; extension({ on: (name, handler) => { handlers[name] = handler; } });
  let name = 'spike'; const ctx = { cwd: repo, isIdle: () => true, sessionManager: { getSessionId: () => 'pi-session-uuid', getSessionFile: () => '/tmp/pi-session.jsonl', getSessionName: () => name } };
  handlers.session_start({ reason: 'resume' }, ctx); name = 'renamed'; handlers.session_info_changed({ name }, ctx); handlers.tool_call({ toolName: 'bash', toolCallId: 'tool-1' }, ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.GOLEM_HOME, 'session-facts.json'))).facts[0].observations.tool_name, 'bash'); handlers.agent_settled({}, ctx);
  const fact = JSON.parse(fs.readFileSync(path.join(env.GOLEM_HOME, 'session-facts.json'))).facts[0]; assert.equal(fact.canonical_id, 'pi-session-uuid'); assert.equal(fact.name, 'renamed'); assert.equal(fact.status, 'idle');
  const inboxDir = path.join(env.GOLEM_HOME, 'pi-inbox', 'pi-session-uuid');
  // Production drainer accepts a Pi dispatch durably as queued/next-turn even
  // though the target has no push channel.
  let queueStatus = 'pending', envelopeDelivered = false, commentsDelivered = false, passiveDelivered = false; const ticket = { id: 'GOL-460', title: 'Pi', project_id: 'test' };
  const tracker = { listPendingDispatches: () => queueStatus === 'pending' ? [{ id: 'q1', ticket_id: ticket.id, session_id: 'pi-session-uuid', envelope_id: 'e1', created_at: new Date().toISOString() }] : [], unackedDispatchesForWindow: () => [], claimDueEscalation: () => null, claimDueAckPing: () => null, waveGateForTicket: () => ({ blocked: false }), getTicket: () => ticket, getEnvelope: () => null, setDispatched: () => ticket, claimPassiveDelta: () => ({ lease_id: 'p1', batch: { body: 'passive' } }), commitPassiveDelta: () => { passiveDelivered = true; }, releasePassiveDelta: () => {}, markQueueNextTurn: () => { queueStatus = 'next_turn'; }, markQueueDelivered: () => { queueStatus = 'delivered'; }, markEnvelopeDelivery: () => { envelopeDelivered = true; }, markCommentDispatchesDeliveredForTicket: () => { commentsDelivered = true; }, activeSubscriptionsBySession: () => new Map() };
  const drainer = initDispatchDrainer({ tracker, state: { nativeSessions: () => [{ session_id: 'pi-session-uuid', harness: 'pi', alive: true, status: 'idle' }] }, chat: { record: () => {} }, pushBrief: async () => { throw new Error('Pi must not push'); }, buildDispatchBrief: () => 'production queued brief', broadcastWS: () => {}, listChannels: async () => [] });
  await drainer.tick(); assert.equal(queueStatus, 'next_turn'); assert.equal(envelopeDelivered, false); assert.equal(commentsDelivered, false); assert.equal(passiveDelivered, false);
  // Every acknowledged enqueue owns a distinct linked file; a second producer
  // cannot write an inode that the consumer has renamed/unlinked.
  const concurrent = enqueuePiBrief('pi-session-uuid', 'concurrent', {}, { home: env.GOLEM_HOME, file: path.join(env.GOLEM_HOME, 'session-facts.json') }); assert.equal(concurrent.queued, true); assert.equal(fs.readdirSync(path.join(inboxDir, 'pending')).length, 2);
  assert.match(handlers.input({ text: 'next turn' }, ctx).text, /production queued brief/); assert.equal(fs.readdirSync(path.join(inboxDir, 'acks')).length, 2);
  await drainer.tick(); drainer.close(); assert.equal(queueStatus, 'delivered'); assert.equal(envelopeDelivered, true); assert.equal(commentsDelivered, true); assert.equal(passiveDelivered, true);
  const native = spawnSync('pi', ['--version'], { env, encoding: 'utf8' });
  console.log(`pi native ${native.status === 0 ? `present: ${native.stdout.trim()}` : 'absent'}; node ${process.version}; delivery Tier B (no live idle endpoint proven)`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
