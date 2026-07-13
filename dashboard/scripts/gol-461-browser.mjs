import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { projectIdFor } from '../server/project-id.js';
import { acquireChrome } from './_chrome.mjs';

const ok = (condition, message) => { if (!condition) throw new Error(message); console.log(`  ok  ${message}`); };
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-461-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
const alpha = path.join(projects, 'alpha');
const beta = path.join(projects, 'beta');
for (const dir of [home, alpha, beta]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(alpha, 'CLAUDE.md'), '# Alpha fixture\n');
writeFileSync(path.join(beta, 'CLAUDE.md'), '# Beta fixture\n');
utimesSync(beta, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
const alphaId = projectIdFor(alpha);
const betaId = projectIdFor(beta);
writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: alphaId, name: 'Alpha fixture', path: alpha, kind: 'auto' },
  { id: betaId, name: 'Beta fixture', path: beta, kind: 'auto' },
] }));

// A real child process supplies honest liveness; the stale row deliberately has
// no process/channel evidence and must never become dispatchable.
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const now = new Date().toISOString();
const sessionRows = [
  { session_id: 'idle-fixture-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'busy', name: 'Fixture Builder', harness: 'opencode', updated_at: now, last_seen_at: now },
  { session_id: 'stale-fixture-session', project_id: alphaId, project_path: alpha, pid: 2147483647, hook_ppid: 2147483647, status: 'idle', name: 'Stale Ghost', harness: 'claudecode', updated_at: '2020-01-01T00:00:00.000Z' },
] ;
writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: sessionRows }));
const delivered = [];
const channelServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => { delivered.push({ url: req.url, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
await new Promise((resolve) => channelServer.listen(0, '127.0.0.1', resolve));
const channelPort = channelServer.address().port;
writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ channels: [
  { session_id: 'idle-fixture-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'opencode', updated_at: now },
] }));

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  env: { ...process.env, PORT: String(port), GOLEM_HOME: home, GOLEM_PROJECTS_ROOT: projects, GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas') },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let chrome;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const json = async (url, options = {}) => {
    const response = await fetch(base + url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const projectRows = await json('/api/projects');
  const alphaUiId = projectRows.find((p) => p.project_id === alphaId)?.id;
  const betaUiId = projectRows.find((p) => p.project_id === betaId)?.id;
  ok(alphaUiId && betaUiId, 'isolated projects are discovered with canonical contract ids');
  const create = async (title, body) => {
    const result = await json('/api/tickets', { method: 'POST', body: JSON.stringify({ project_id: alphaId, title, body, kind: 'work-item', created_by: 'browser-fixture' }) });
    return result.ticket || result;
  };
  const hostile = await create('Hostile markdown fixture', '# Safe heading\n\n<img src=x onerror="window.__xss=1">\n<script>window.__xss=2</script>\n\n```mermaid\ngraph TD; A-->B\n```');
  const phaseTicket = await create('Phase control fixture', '# Phase control');
  const anchored = await create('Anchored comment fixture', '# Original\n\nAnchor sentence remains.');
  const dispatchable = await json(`/api/sessions/dispatchable?project=${encodeURIComponent(alphaId)}`);
  ok(!dispatchable.some((s) => s.session_id === 'stale-fixture-session'), 'stale session is not dispatchable');
  ok(dispatchable.some((s) => s.session_id === 'idle-fixture-session'), 'live fixture session exposes canonical agent facts');
  const queued = await json(`/api/tickets/${hostile.id}/dispatch`, { method: 'POST', body: JSON.stringify({ session_id: 'idle-fixture-session', mode: 'when_idle' }) });
  ok(queued.queued === true || queued.pending === true || queued.mode === 'when_idle', 'busy-session dispatch is durably queued for idle delivery');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(phaseTicket.id)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (errors.length) console.log('page errors', errors);
  await page.waitForSelector('[role="dialog"]');
  ok(await page.locator('.drawer-ticket[role="dialog"][aria-modal="true"]:visible').count() === 1, 'shared accessible drawer renders as a modal dialog');
  ok(await page.locator('.app > .main[inert][aria-hidden="true"]').count() === 1, 'open drawer makes background inert');
  const stateControl = page.locator('.td-prop').filter({ has: page.locator('.td-prop-label', { hasText: 'State' }) }).locator('.ps-trigger');
  await stateControl.click();
  await page.locator('.ps-option').filter({ hasText: 'in_progress' }).click();
  await page.waitForFunction(async (id) => (await (await fetch(`/api/tickets/${id}`)).json()).phase === 'building', phaseTicket.id);
  ok(true, 'phase update is driven through the exposed ticket state control');
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(hostile.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.drawer-ticket[role="dialog"]');
  ok(await page.locator('script').evaluateAll((nodes) => nodes.every((n) => !/window\.__xss/.test(n.textContent || ''))), 'hostile script is absent from rendered body');
  ok(await page.locator('[onerror]').count() === 0 && await page.evaluate(() => !window.__xss), 'hostile HTML handlers are removed');
  const mermaidRendered = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = window.SubstrateFmt.renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    document.body.appendChild(host);
    await window.runMermaid(host.querySelectorAll('.mermaid'));
    return host.querySelectorAll('.mermaid svg').length;
  });
  ok(mermaidRendered === 1, 'Mermaid renders sanitized Markdown from the local production bundle');
  const failClosed = await page.evaluate(() => {
    const purifier = window.DOMPurify;
    window.DOMPurify = null;
    const rendered = window.SubstrateFmt.renderMarkdown('<img src=x onerror=alert(1)>');
    window.DOMPurify = purifier;
    return rendered;
  });
  ok(failClosed.includes('&lt;img') && !failClosed.includes('<img'), 'Markdown/legacy HTML fails closed without DOMPurify');
  // Escape closes/unmounts descendants and focus returns to the opener target.
  await page.keyboard.press('Shift+Tab');
  ok(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null), 'Shift+Tab remains trapped in the drawer');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  ok(await page.locator('.app > .main[inert]').count() === 0, 'closed drawer unmounts descendants and restores background interactivity');

  // Create an anchored comment and update the body using the exposed UI.
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(anchored.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md');
  await page.evaluate(() => {
    const root = document.querySelector('.td-md');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node; while ((node = walker.nextNode())) if (node.textContent.includes('Anchor sentence remains.')) break;
    const start = node.textContent.indexOf('Anchor sentence remains.');
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'Anchor sentence remains.'.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#anno-pill').click();
  await page.locator('textarea[placeholder^="Comment —"]').fill('Anchored note');
  await page.locator('button.send', { hasText: 'Comment' }).click();
  await page.getByTitle('Edit body').click();
  await page.locator('.td-edit-body').fill('# Updated\n\nPrelude added.\n\nAnchor sentence remains.');
  await page.locator('.td-edit-actions button', { hasText: 'Save' }).click();
  await page.waitForFunction(async (id) => {
    const ticket = await (await fetch(`/api/tickets/${id}`)).json();
    return ticket.body.startsWith('# Updated') && ticket.comments.some((c) => c.body === 'Anchored note' && c.quote === 'Anchor sentence remains.');
  }, anchored.id);
  ok(true, 'anchored comment survives a body update through UI controls');
  await page.goto(`${base}/project/${encodeURIComponent(betaUiId)}`, { waitUntil: 'networkidle' });
  ok(page.url().includes(encodeURIComponent(betaUiId)) && await page.getByText('Beta fixture', { exact: true }).count() > 0, 'project deep link restores selection');
  await page.evaluate((id) => localStorage.setItem('golem.sidebar.pinnedProjects', JSON.stringify([id])), betaUiId);
  await page.reload({ waitUntil: 'networkidle' });
  ok((await page.locator('.sidebar-bucket.bucket-pinned .sidebar-freshness').innerText()).toLowerCase().includes('archived'), 'pinned archived project shows explicit freshness');
  await page.locator(`.sidebar-project-row a[href^="/project/${alphaUiId}"]`).click();
  await page.waitForFunction((id) => location.pathname.includes(id), alphaUiId);
  ok(true, 'sidebar project switch updates the route');
  await page.goto(`${base}/agents`, { waitUntil: 'networkidle' });
  const agentCard = page.locator('.native-session-card').filter({ hasText: 'Fixture Builder' });
  await agentCard.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"]');
  const agentText = await page.locator('[role="dialog"]').innerText();
  for (const fact of ['session_id', 'harness', 'last seen', 'endpoint', 'Fixture Builder']) ok(agentText.toLowerCase().includes(fact.toLowerCase()), `agent detail shows canonical ${fact} fact`);
  await page.evaluate((id) => window.Router.openTicket(id), hostile.id);
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
  ok(await page.locator('.app > .main[inert]').count() === 1, 'nested drawers keep the background inert');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
  ok((await page.locator('[role="dialog"]').getAttribute('aria-label')).startsWith('Agent details'), 'one Escape closes only the top drawer');
  ok(await page.locator('.app > .main[inert]').count() === 1, 'lower drawer remains modal and background stays inert');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  ok(await page.locator('.app > .main[inert]').count() === 0, 'second Escape releases background inertness');
  ok(await page.evaluate(() => document.activeElement?.classList.contains('native-session-card')), 'nested stack restores the original opener after the lower closes');

  // Move the seeded session from busy to idle and require the drainer to POST
  // the queued envelope to its isolated fake channel, then remove the queue row.
  sessionRows[0] = { ...sessionRows[0], status: 'idle', updated_at: new Date().toISOString(), last_seen_at: new Date().toISOString() };
  writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: sessionRows }));
  for (let i = 0; i < 60 && !delivered.some((entry) => entry.url === '/brief'); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  ok(delivered.some((entry) => entry.url === '/brief'), 'queued envelope is delivered when the agent becomes idle');
  const remainingQueue = await json(`/api/dispatch-queue?session=idle-fixture-session`);
  ok(remainingQueue.length === 0, 'delivered idle envelope is consumed from the durable queue');

  const distFiles = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const file = path.join(dir, name); statSync(file).isDirectory() ? walk(file) : distFiles.push(file); } };
  walk(path.resolve('dashboard/dist'));
  // Namespace/specification URLs embedded by React/Mermaid are inert. Reject
  // hosted module/CDN/Babel sources across every emitted file.
  const forbidden = /https?:\/\/(?:unpkg\.com|esm\.sh)|@babel\/standalone|babel\.min\.js/ig;
  const hits = distFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(forbidden)].map((m) => `${path.basename(file)}:${m[0]}`));
  ok(hits.length === 0, `all ${distFiles.length} dist assets are free of runtime CDN/Babel references${hits.length ? ` (${hits.slice(0, 3).join(', ')})` : ''}`);
  ok(errors.length === 0, `browser emitted no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  const screenshot = path.join(scratch, 'agent-facts.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`GOL-461 seeded browser journeys passed; isolated port=${port}; screenshot=${screenshot}`);
} finally {
  if (chrome) await chrome.cleanup();
  server.kill('SIGTERM');
  worker.kill('SIGTERM');
  channelServer.close();
  if (server.exitCode != null && server.exitCode !== 0) rmSync(scratch, { recursive: true, force: true });
}
