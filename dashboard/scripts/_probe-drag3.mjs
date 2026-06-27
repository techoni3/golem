import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const url = 'http://127.0.0.1:7420/?bust=' + Date.now();
const tid = 'TKT-0002';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userDataDir = path.join(os.tmpdir(), 'golem-drag3-' + Date.now());
const cdpPort = 9323;
const child = spawn(chrome, [
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
  '--headless=new','--no-first-run','--no-default-browser-check','--disable-default-apps', url,
], { detached: true, stdio: 'ignore' });
child.unref();
await new Promise(r => setTimeout(r, 5000));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(4000);
const trackerLink = page.locator('.sidebar-link').filter({ hasText: 'Tracker' }).first();
if (await trackerLink.count() > 0) await trackerLink.click();
await page.waitForTimeout(2500);

// Pick the first ticket in the todo column
const card = page.locator('[data-col="todo"] [data-ticket-id]').first();
const targetCol = page.locator('[data-col="in_progress"]').first();
const cBox = await card.boundingBox();
const tBox = await targetCol.boundingBox();
const cardId = await card.getAttribute('data-ticket-id');
console.log('DRAGGING', cardId, 'FROM', cBox, 'TO', tBox);
const before = await page.evaluate((id) => window.Store.getState().trackerTickets.get(id)?.state, cardId);
console.log('BEFORE state:', before);

if (cBox && tBox) {
  const sx = cBox.x + cBox.width / 2;
  const sy = cBox.y + cBox.height / 2;
  const ex = tBox.x + tBox.width / 2;
  const ey = tBox.y + 80;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10, { steps: 5 });
  await page.mouse.move(ex, ey, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

const after = await page.evaluate((id) => {
  const c = document.querySelector(`[data-ticket-id="${id}"]`);
  const col = c?.closest('.kanban-col')?.getAttribute('data-col');
  const t = window.Store.getState().trackerTickets.get(id);
  return { col, serverState: t?.state };
}, cardId);
console.log('AFTER', JSON.stringify(after));
console.log('ERRORS', JSON.stringify(errors));
await page.screenshot({ path: '/tmp/tkt-drag-final.png' });
await browser.close();
try { process.kill(child.pid, 'SIGTERM'); } catch {}
