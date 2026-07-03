// Integration test for tracker-client.js — exercises the FULL HTTP client
// against a real dashboard server, on a throwaway port + temp config + temp DB.
//
// It NEVER touches the live :7420 dashboard or the real ~/.config/golem state:
//   - the dashboard child runs on PORT=7616 (HOST=127.0.0.1),
//   - GOLEM_TRACKER_DB points at a temp file,
//   - XDG_CONFIG_HOME points at a temp dir, so the dashboard self-registers
//     dashboard.json INTO that temp dir, and the client reads it from there.
//
// Exit 0 on full success; exit 1 on any failed assertion or round-trip.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_SERVER = path.resolve(__dirname, '../../dashboard/server/index.js');

const PORT = 7616;
const HOST = '127.0.0.1';
const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const PROJECT_ID = 'testproj-abc123'; // synthetic contract id; we pass it explicitly

// --- temp sandbox ----------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-tracker-test-'));
const tmpConfigHome = path.join(tmpRoot, 'config'); // XDG_CONFIG_HOME
const tmpDb = path.join(tmpRoot, 'tracker.db');
fs.mkdirSync(tmpConfigHome, { recursive: true });

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait until the dashboard self-registers dashboard.json and the API routes are
// ready (we poll /api/tickets, which 200s once routes are up).
async function waitForDashboard(timeoutMs = 15000) {
  const dashJson = path.join(tmpConfigHome, 'golem', 'dashboard.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dashJson)) {
      try {
        const doc = JSON.parse(fs.readFileSync(dashJson, 'utf8'));
        if (doc.url) {
          const res = await fetch(`${doc.url}/api/tickets`).catch(() => null);
          if (res && res.ok) return doc;
        }
      } catch {
        /* not ready yet */
      }
    }
    await sleep(200);
  }
  throw new Error('dashboard did not become ready within timeout');
}

let child;
async function main() {
  // 1) Spawn the dashboard server in the sandbox.
  child = spawn('node', [DASHBOARD_SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      GOLEM_TRACKER_DB: tmpDb,
      XDG_CONFIG_HOME: tmpConfigHome,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stderr.write(`[dash] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[dash:err] ${d}`));

  const doc = await waitForDashboard();
  check('dashboard self-registered dashboard.json', !!doc.url, JSON.stringify(doc));
  check('dashboard.json url points at our test port', String(doc.url).includes(`:${PORT}`), doc.url);

  // 2) Configure env so the client resolves THIS dashboard + identity, then
  //    import the client (its helpers read env/fs lazily at call time).
  process.env.XDG_CONFIG_HOME = tmpConfigHome;
  process.env.GOLEM_CEO_SESSION_ID = SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  const client = await import('./tracker-client.js');

  check('dashboardBaseUrl() reads temp dashboard.json', client.dashboardBaseUrl() === doc.url,
    `got ${client.dashboardBaseUrl()} want ${doc.url}`);
  check('currentSessionId() reflects GOLEM_CEO_SESSION_ID', client.currentSessionId() === SESSION_ID,
    client.currentSessionId());

  // 3) createTicket → getTicket round-trip.
  const created = await client.createTicket({
    project_id: PROJECT_ID,
    title: 'Test ticket from client',
    body: 'acceptance: round-trips',
    kind: 'work-item',
    assignee: SESSION_ID,
    created_by: SESSION_ID,
  });
  check('createTicket returns an id', !!created?.id, JSON.stringify(created));
  check('createTicket persisted project_id', created.project_id === PROJECT_ID, created.project_id);
  check('createTicket default state todo', created.state === 'todo', created.state);

  const fetched = await client.getTicket(created.id);
  check('getTicket returns the same title', fetched?.title === 'Test ticket from client', fetched?.title);
  check('getTicket includes comments array', Array.isArray(fetched?.comments), typeof fetched?.comments);

  // 4) listTickets — project filter, then assignee (mine) filter.
  const byProject = await client.listTickets({ project: PROJECT_ID });
  check('listTickets(project) finds the ticket', byProject.some((t) => t.id === created.id), `n=${byProject.length}`);

  const mine = await client.listTickets({ project: PROJECT_ID, assignee: SESSION_ID });
  check('listTickets(assignee=mine) finds the ticket', mine.some((t) => t.id === created.id), `n=${mine.length}`);

  const notMine = await client.listTickets({ project: PROJECT_ID, assignee: 'human' });
  check('listTickets(assignee=human) excludes it', !notMine.some((t) => t.id === created.id), `n=${notMine.length}`);

  // 5) updateTicket(state) → in_progress.
  const updated = await client.updateTicket(created.id, { state: 'in_progress', actor: SESSION_ID });
  check('updateTicket flips state to in_progress', updated.state === 'in_progress', updated.state);
  const reFetched = await client.getTicket(created.id);
  check('getTicket sees the persisted state', reFetched.state === 'in_progress', reFetched.state);

  // 6) addComment.
  const comment = await client.addComment(created.id, { author: SESSION_ID, body: 'progress: did the thing' });
  check('addComment returns a comment', !!comment?.id || !!comment?.body, JSON.stringify(comment));
  const withComment = await client.getTicket(created.id);
  check('getTicket now has the comment', withComment.comments.some((c) => /did the thing/.test(c.body)),
    `n=${withComment.comments.length}`);

  // 7) createStream → listStreams.
  const stream = await client.createStream({ project_id: PROJECT_ID, name: 'Test stream', mode: 'sequential' });
  check('createStream returns an id', !!stream?.id, JSON.stringify(stream));
  const streams = await client.listStreams(PROJECT_ID);
  check('listStreams finds the stream', streams.some((s) => s.id === stream.id), `n=${streams.length}`);

  // 8) listDispatchable (no live native sessions in the sandbox → empty array, but must 200).
  const dispatchable = await client.listDispatchable(PROJECT_ID);
  check('listDispatchable returns an array', Array.isArray(dispatchable), typeof dispatchable);

  // 9) Error path — non-2xx surfaces the server error + status.
  let threw = null;
  try {
    await client.getTicket('does-not-exist-id');
  } catch (e) {
    threw = e;
  }
  check('getTicket(unknown) throws with status', threw && /404/.test(threw.message), threw?.message);

  let badCreate = null;
  try {
    await client.createTicket({ project_id: PROJECT_ID }); // missing title → 400
  } catch (e) {
    badCreate = e;
  }
  check('createTicket(no title) throws 400 with server error', badCreate && /400/.test(badCreate.message), badCreate?.message);
}

main()
  .catch((err) => {
    failures++;
    console.error('UNHANDLED:', err?.stack || err);
  })
  .finally(() => {
    // Kill child, clean temp.
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    if (failures === 0) {
      console.log('\nALL PASS (exit 0)');
      process.exit(0);
    } else {
      console.log(`\n${failures} FAILURE(S) (exit 1)`);
      process.exit(1);
    }
  });
