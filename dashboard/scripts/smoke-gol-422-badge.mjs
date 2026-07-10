#!/usr/bin/env node
// GOL-422 headless badge smoke. A fresh dashboard + temp DB renders the
// existing agent/ticket badge spine for a durable escalated envelope.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium } from 'playwright-core';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const server = path.resolve(here, '..', 'server', 'index.js');
const tag = crypto.randomBytes(4).toString('hex');
const port = 7662;
const base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `golem-422-badge-${tag}-`));
const dbPath = path.join(dir, 'tracker.db');
const projects = path.join(dir, 'projects');
fs.mkdirSync(path.join(projects, 'badge-demo'), { recursive: true });
fs.writeFileSync(path.join(projects, 'badge-demo', 'CLAUDE.md'), '# badge smoke\n');
const child = spawn('node', [server], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GOLEM_TRACKER_DB: dbPath, XDG_CONFIG_HOME: dir, GOLEM_PROJECTS_ROOT: projects, GOLEM_IDEAS_ROOT: path.join(dir, 'ideas') }, stdio: 'ignore' });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await wait(100); }
  const created = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: 'badge-demo', kind: 'work-item', title: 'GOL-422 badge', body: '' }) }).then((r) => r.json());
  const dispatched = await fetch(`${base}/api/tickets/${created.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'badge-target' }) }).then((r) => r.json());
  const db = new Database(dbPath);
  db.prepare("UPDATE message_envelopes SET delivery_attempted_at = ?, delivery_opportunity_at = ?, escalation_envelope_id = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), 'escalated-child', dispatched.envelope_id);
  db.close();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/tracker`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.unacked-dispatch-badge.severity-escalated', { timeout: 10_000 });
  const text = await page.locator('.unacked-dispatch-badge.severity-escalated').first().textContent();
  if (!/escalated/.test(text || '') || errors.length) throw new Error(`badge=${text}; pageerrors=${errors.join('; ')}`);
  await browser.close();
  console.log('PASS GOL-422 headless badge smoke');
} finally {
  try { child.kill('SIGTERM'); } catch {}
  await wait(200);
  fs.rmSync(dir, { recursive: true, force: true });
}
