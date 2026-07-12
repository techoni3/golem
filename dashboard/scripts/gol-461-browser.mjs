import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [
  { session_id: 'idle-fixture-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'busy', name: 'Fixture Builder', harness: 'opencode', updated_at: now, last_seen_at: now },
  { session_id: 'stale-fixture-session', project_id: alphaId, project_path: alpha, pid: 2147483647, hook_ppid: 2147483647, status: 'idle', name: 'Stale Ghost', harness: 'claudecode', updated_at: '2020-01-01T00:00:00.000Z' },
] }));
writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ channels: [
  { session_id: 'idle-fixture-session', pid: worker.pid, harness: 'opencode', updated_at: now },
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
  const create = (title, body) => json('/api/tickets', { method: 'POST', body: JSON.stringify({ project_id: alphaId, title, body, kind: 'work-item', created_by: 'browser-fixture' }) });
  const hostile = await create('Hostile markdown fixture', '# Safe heading\n\n<img src=x onerror="window.__xss=1">\n<script>window.__xss=2</script>\n\n```mermaid\ngraph TD; A-->B\n```');
  const anchored = await create('Anchored comment fixture', '# Original\n\nAnchor sentence remains.');
  await json(`/api/tickets/${anchored.display_id || anchored.id}/comments`, { method: 'POST', body: JSON.stringify({ author: 'browser-fixture', body: 'Anchored note', quote: 'Anchor sentence remains.', tag: 'note' }) });
  await json(`/api/tickets/${anchored.display_id || anchored.id}`, { method: 'PATCH', body: JSON.stringify({ body: '# Updated\n\nPrelude added.\n\nAnchor sentence remains.', actor: 'browser-fixture' }) });
  const detail = await json(`/api/tickets/${anchored.display_id || anchored.id}`);
  ok(detail.comments.some((c) => c.body === 'Anchored note' && c.quote === 'Anchor sentence remains.'), 'anchored comment persists after body update');
  await json(`/api/tickets/${hostile.display_id || hostile.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'in_progress', actor: 'browser-fixture' }) });
  ok((await json(`/api/tickets/${hostile.display_id || hostile.id}`)).state === 'in_progress', 'phase/state update persists');
  const dispatchable = await json(`/api/sessions/dispatchable?project=${encodeURIComponent(alphaId)}`);
  ok(!dispatchable.some((s) => s.session_id === 'stale-fixture-session'), 'stale session is not dispatchable');
  ok(dispatchable.some((s) => s.session_id === 'idle-fixture-session'), 'live fixture session exposes canonical agent facts');
  const queued = await json(`/api/tickets/${hostile.display_id || hostile.id}/dispatch`, { method: 'POST', body: JSON.stringify({ session_id: 'idle-fixture-session', mode: 'when_idle' }) });
  ok(queued.queued === true || queued.pending === true || queued.mode === 'when_idle', 'busy-session dispatch is durably queued for idle delivery');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(hostile.display_id || hostile.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[role="dialog"]');
  ok(await page.locator('.drawer-ticket[role="dialog"][aria-modal="true"]:visible').count() === 1, 'shared accessible drawer renders as a modal dialog');
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
  await page.goto(`${base}/project/${encodeURIComponent(betaUiId)}`, { waitUntil: 'networkidle' });
  ok(page.url().includes(encodeURIComponent(betaUiId)) && await page.getByText('Beta fixture', { exact: true }).count() > 0, 'project deep link restores selection');
  await page.locator(`.sidebar-project-row a[href^="/project/${alphaUiId}"]`).click();
  await page.waitForFunction((id) => location.pathname.includes(id), alphaUiId);
  ok(true, 'sidebar project switch updates the route');
  await page.goto(`${base}/agents?ns=idle-fixture-session`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[role="dialog"]');
  const agentText = await page.locator('[role="dialog"][aria-hidden="false"]').innerText();
  for (const fact of ['session_id', 'harness', 'last seen', 'endpoint', 'Fixture Builder']) ok(agentText.toLowerCase().includes(fact.toLowerCase()), `agent detail shows canonical ${fact} fact`);

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
  if (server.exitCode != null && server.exitCode !== 0) rmSync(scratch, { recursive: true, force: true });
}
