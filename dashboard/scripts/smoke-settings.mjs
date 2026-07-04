#!/usr/bin/env node
// P7 settings-page journey smoke. Runs an isolated dashboard, opens /settings in
// headless Chrome, toggles opencode off, verifies disabled matrix cells, clicks
// Sync Now, and captures a screenshot for review evidence.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { acquireChrome } from './_chrome.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');
const PORT = 7612;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TAG = crypto.randomBytes(6).toString('hex');
const TMP_DB = path.join(os.tmpdir(), `golem-settings-smoke-${TAG}.db`);
const TMP_XDG = fs.mkdtempSync(path.join(os.tmpdir(), `golem-settings-smoke-xdg-${TAG}-`));
const SCREENSHOT = path.join(os.tmpdir(), `golem-settings-smoke-${TAG}.png`);

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function cleanupFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(TMP_DB + suffix, { force: true }); } catch {}
  }
  try { fs.rmSync(TMP_XDG, { recursive: true, force: true }); } catch {}
}

const child = spawn('node', [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST,
    GOLEM_TRACKER_DB: TMP_DB,
    XDG_CONFIG_HOME: TMP_XDG,
    LOG_LEVEL: 'warn',
    GOLEM_PROJECTS_ROOT: path.join(TMP_XDG, 'projects'),
    GOLEM_IDEAS_ROOT: path.join(TMP_XDG, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childExited = false;
child.on('exit', () => { childExited = true; });
child.stderr.on('data', (d) => {
  const s = d.toString();
  if (/EADDRINUSE|fatal|Error:/i.test(s)) process.stderr.write(`[child] ${s}`);
});

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) throw new Error('child exited before becoming healthy');
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('server did not become healthy in time');
}

async function putConfig(body) {
  const r = await fetch(`${BASE}/api/substrate/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`config PUT failed ${r.status}: ${await r.text()}`);
}

let chrome = null;
try {
  await waitForHealth();
  check('server: /api/health ok', true);
  await putConfig({ harnesses: { opencode: { enabled: true } } });

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage();
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sync-matrix"]', { timeout: 15000 });
  check('settings page: matrix renders', await page.locator('[data-testid="sync-matrix"]').count() === 1);
  check('settings page: initial drift is visible', await page.locator('.settings-chip.drifted').count() > 0);

  const oc = page.locator('[data-testid="harness-opencode"]');
  check('settings page: opencode switch initially enabled', await oc.isChecked());
  await oc.click();
  await page.waitForFunction(() => {
    const chips = [...document.querySelectorAll('.settings-chip')];
    return chips.some((n) => n.textContent.trim() === 'disabled');
  }, null, { timeout: 10000 });
  check('settings page: toggle opencode off shows disabled cells', await page.locator('.settings-chip.disabled').count() > 0);

  await page.locator('[data-testid="sync-now"]').click();
  await page.waitForSelector('[data-testid="sync-result"]', { timeout: 30000 });
  const syncText = await page.locator('[data-testid="sync-result"]').innerText();
  check('settings page: Sync Now result appears', /"status":\s*"ok"/.test(syncText) || /"status":\s*"skipped"/.test(syncText), syncText.slice(0, 160));
  await page.waitForFunction(() => {
    return document.querySelectorAll('tbody tr td:nth-child(2) .settings-chip.drifted').length === 0;
  }, null, { timeout: 15000 });
  check('settings page: Sync Now clears claudecode drift', await page.locator('tbody tr td:nth-child(2) .settings-chip.drifted').count() === 0);

  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  check('settings page: screenshot captured', fs.existsSync(SCREENSHOT), SCREENSHOT);
} catch (err) {
  failures++;
  console.log(`[FAIL] unexpected exception — ${err && err.stack ? err.stack : err}`);
} finally {
  if (chrome) await chrome.cleanup();
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((res) => setTimeout(res, 400));
  if (!childExited) { try { child.kill('SIGKILL'); } catch {} }
  cleanupFiles();
  if (failures === 0) console.log(`\nALL CHECKS PASSED\nscreenshot: ${SCREENSHOT}`);
  else console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
