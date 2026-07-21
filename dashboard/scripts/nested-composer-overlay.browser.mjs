// Regression journey: a work-item composer opened from a spec owns the top
// overlay layer, while the spec remains available when the composer closes.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { strict as assert } from 'node:assert';
import { projectIdFor } from '../server/project-id.js';
import { acquireChrome } from './_chrome.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-compose-layer-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
const projectPath = path.join(projects, 'fixture');
for (const dir of [home, projectPath]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Nested composer fixture\n');
const projectId = projectIdFor(projectPath);
writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: projectId, name: 'Nested composer fixture', path: projectPath, kind: 'auto' },
] }));

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(port),
    GOLEM_HOME: home,
    GOLEM_PROJECTS_ROOT: projects,
    GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;

async function api(pathname, options = {}) {
  const response = await fetch(`${base}/api${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body.ticket || body;
}

async function stopServer() {
  if (server.exitCode != null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

let chrome;
try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, 'isolated dashboard reached its health endpoint');

  const spec = await api('/tickets', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, kind: 'spec', created_by: 'browser-fixture', title: 'Nested composer spec', body: 'Fixture spec.' }),
  });
  await api('/tickets', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, kind: 'work-item', parent_id: spec.id, created_by: 'browser-fixture', title: 'Existing child', body: 'Fixture child.' }),
  });

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/specs?ticket=${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.locator('.drawer-ticket .td-children-add').click();
  await page.waitForSelector('.drawer-compose[role="dialog"][aria-modal="true"]');

  const layer = await page.evaluate(() => {
    const composer = document.querySelector('.drawer-compose');
    const ticket = document.querySelector('.drawer-ticket');
    const backdrop = document.querySelector('.drawer-compose-backdrop');
    if (!composer || !ticket || !backdrop) return null;
    const rect = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 48, rect.top + 48);
    return {
      composerTop: composer.dataset.modalTop,
      ticketInert: ticket.inert,
      composerZ: Number(getComputedStyle(composer).zIndex),
      ticketZ: Number(getComputedStyle(ticket).zIndex),
      backdropZ: Number(getComputedStyle(backdrop).zIndex),
      hitComposer: hit?.closest('.drawer-compose') === composer,
    };
  });
  assert.deepEqual(layer, {
    composerTop: 'true', ticketInert: true, composerZ: 80,
    ticketZ: 60, backdropZ: 70, hitComposer: true,
  }, 'the composer owns the top visual and keyboard layer');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.drawer-compose'));
  assert.equal(await page.locator('.drawer-ticket').count(), 1, 'Escape closes only the composer and returns to the spec drawer');
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  console.log('nested composer overlay browser journey passed');
} finally {
  if (chrome) await chrome.cleanup();
  await stopServer();
  rmSync(scratch, { recursive: true, force: true });
}
