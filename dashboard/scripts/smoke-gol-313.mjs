import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openTrackerDb } from '../server/tracker-db.js';

const PROJECT = 'golem-1eba80';
const SESSION = 'smoke-gol-313-session';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function projectIdFor(root) {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const hash = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 6);
  return `${slug}-${hash}`;
}

const tracker = openTrackerDb(':memory:').init();

try {
  const schema = tracker.raw().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
  assert.equal(schema, '10', 'schema v10 is active');

  const sub = tracker.subscribe({ session_id: SESSION, topic: `ticket/SMOKE-GOL-313`, cursor_seq: 0 });
  const end = tracker.ingestBusEvents({ uuid: 'smoke-gol-313-end', event: 'session-end', session_id: SESSION, project_id: PROJECT });
  const dup = tracker.ingestBusEvents({ uuid: 'smoke-gol-313-end', event: 'session-end', session_id: SESSION, project_id: PROJECT });
  const afterEnd = tracker.listSubscriptions({ session_id: SESSION })[0];
  assert.equal(end.inserted, 1, 'first ingest inserts primary event');
  assert.equal(end.roster_inserted, 1, 'session-end emits roster event');
  assert.equal(dup.duplicates, 1, 'duplicate source uuid is skipped');
  assert.equal(dup.roster_inserted, 0, 'duplicate roster uuid is skipped');
  assert.equal(afterEnd.status, 'suspended', 'session-end suspends subscriptions');

  const start = tracker.ingestBusEvents({ uuid: 'smoke-gol-313-start', event: 'session-start', session_id: SESSION, project_id: PROJECT });
  const afterStart = tracker.listSubscriptions({ session_id: SESSION })[0];
  assert.equal(start.events[0].subscription_lifecycle.reactivated, 1, 'session-start reactivates subscriptions');
  assert.equal(afterStart.status, 'active', 'subscription is active after session-start');
  assert.equal(afterStart.cursor_seq, sub.cursor_seq, 'cursor remains frozen across suspend/reactivate');

  const activity = tracker.ingestBusEvents({ uuid: 'smoke-gol-313-activity', event: 'tool-pre', session_id: SESSION, project_id: PROJECT });
  assert.equal(activity.events[0].class, 'activity', 'tool hook maps to activity class');
  const defaultSub = tracker.subscribe({ session_id: SESSION, topic: `session/${SESSION}`, cursor_seq: 0 });
  const pending = tracker.pendingEventsForSubscription(defaultSub);
  assert.equal(pending.events.some((e) => e.class === 'activity'), false, 'default subscription filters exclude activity');

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'golem-gol-313-'));
  const golemHome = path.join(tempRoot, 'home');
  const project = path.join(tempRoot, 'project');
  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.mkdir(golemHome, { recursive: true });
  const hook = path.resolve('substrate/hooks/journal-route.sh');
  const hookPayload = JSON.stringify({ session_id: SESSION, cwd: project });
  const hookRun = spawnSync('bash', [hook, 'session-end'], {
    cwd: project,
    input: hookPayload,
    encoding: 'utf8',
    env: { ...process.env, GOLEM_HOME: golemHome, GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(hookRun.status, 0, `hook exits fail-open: ${hookRun.stderr}`);
  await wait(1400);
  const spool = await fs.readFile(path.join(golemHome, 'spool', `${SESSION}.jsonl`), 'utf8');
  assert.ok(spool.includes('session-end'), 'dashboard-down hook event remains in local spool');
  const journal = await fs.readFile(path.join(golemHome, 'journals', projectIdFor(project), 'hook.jsonl'), 'utf8');
  assert.ok(journal.includes('session-end'), 'hook journal write is preserved');

  console.log(JSON.stringify({
    ok: true,
    schema,
    ingest: { end, dup, start: { inserted: start.inserted, roster_inserted: start.roster_inserted } },
    subscription_status: { after_end: afterEnd.status, after_start: afterStart.status },
    default_filter_seen: pending.events.map((e) => e.class),
    hook_spool_bytes: spool.length,
  }, null, 2));
} finally {
  tracker.close();
}
