import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { acquireChrome } from './_chrome.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'golem-461-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
mkdirSync(home, { recursive: true });
mkdirSync(projects, { recursive: true });
writeFileSync(path.join(home, 'projects.json'), '{"projects":[]}\n');

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
  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/tracker?project=fixture-000001&kind=fix&assignee=human&q=offline&archived=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#root .app');
  const html = await (await fetch(base)).text();
  if (/unpkg|esm\.sh|babel/i.test(html)) throw new Error('production HTML contains a runtime CDN/Babel reference');
  const url = new URL(page.url());
  for (const [key, value] of Object.entries({ project: 'fixture-000001', kind: 'fix', assignee: 'human', q: 'offline', archived: '1' })) {
    if (url.searchParams.get(key) !== value) throw new Error(`filter ${key} was not URL-restored`);
  }
  if (errors.length) throw new Error(`browser page errors: ${errors.join('; ')}`);
  const screenshot = path.join(scratch, 'tracker-filters.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`GOL-461 browser journey passed; isolated port=${port}; screenshot=${screenshot}`);
} finally {
  if (chrome) await chrome.cleanup();
  server.kill('SIGTERM');
  // Keep successful evidence in OS temp for this run; failed starts are still
  // isolated and the OS cleans the directory.
  if (server.exitCode != null && server.exitCode !== 0) rmSync(scratch, { recursive: true, force: true });
}
