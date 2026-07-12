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
  const inboxDir = path.join(env.GOLEM_HOME, 'pi-inbox'); fs.mkdirSync(inboxDir); fs.writeFileSync(path.join(inboxDir, 'pi-session-uuid.jsonl'), '{"text":"queued brief"}\nnot-json\n');
  assert.match(handlers.input({ text: 'next turn' }, ctx).text, /queued brief/); assert.equal(fs.existsSync(path.join(inboxDir, 'pi-session-uuid.jsonl')), false); assert.match(fs.readFileSync(path.join(inboxDir, 'pi-session-uuid.jsonl.dead-letter.jsonl'), 'utf8'), /not-json/);
  // Production drainer accepts a Pi dispatch durably as queued/next-turn even
  // though the target has no push channel.
  let marked = null; const ticket = { id: 'GOL-460', title: 'Pi', project_id: 'test' };
  const tracker = { listPendingDispatches: () => [{ id: 'q1', ticket_id: ticket.id, session_id: 'pi-session-uuid', created_at: new Date().toISOString() }], unackedDispatchesForWindow: () => [], claimDueEscalation: () => null, claimDueAckPing: () => null, waveGateForTicket: () => ({ blocked: false }), getTicket: () => ticket, setDispatched: () => ticket, claimPassiveDelta: () => null, markQueueDelivered: (_id, value) => { marked = value; }, markCommentDispatchesDeliveredForTicket: () => {}, activeSubscriptionsBySession: () => new Map() };
  const drainer = initDispatchDrainer({ tracker, state: { nativeSessions: () => [{ session_id: 'pi-session-uuid', harness: 'pi', alive: true, status: 'idle' }] }, chat: { record: () => {} }, pushBrief: async () => { throw new Error('Pi must not push'); }, buildDispatchBrief: () => 'production queued brief', broadcastWS: () => {}, listChannels: async () => [] });
  await drainer.tick(); drainer.close(); assert.deepEqual(marked, { error: null, envelope_id: null }); assert.match(fs.readFileSync(path.join(inboxDir, 'pi-session-uuid.jsonl'), 'utf8'), /production queued brief/);
  // Rename-first claim leaves concurrent producer appends in a fresh inbox.
  const current = path.join(inboxDir, 'pi-session-uuid.jsonl'); const claimed = `${current}.claimed-test`; fs.renameSync(current, claimed); assert.equal(enqueuePiBrief('pi-session-uuid', 'concurrent', {}, { home: env.GOLEM_HOME, file: path.join(env.GOLEM_HOME, 'session-facts.json') }).queued, true); assert.match(fs.readFileSync(claimed, 'utf8'), /production queued brief/); assert.match(fs.readFileSync(current, 'utf8'), /concurrent/);
  const native = spawnSync('pi', ['--version'], { env, encoding: 'utf8' });
  console.log(`pi native ${native.status === 0 ? `present: ${native.stdout.trim()}` : 'absent'}; node ${process.version}; delivery Tier B (no live idle endpoint proven)`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
