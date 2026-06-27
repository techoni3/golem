import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const url = process.argv[2] || 'http://127.0.0.1:7420/';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userDataDir = path.join(os.tmpdir(), 'golem-tkt9-chrome-profile');
const cdpPort = 9224;

const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

await new Promise((resolve) => setTimeout(resolve, 2500));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const context = browser.contexts()[0];
let page = context.pages()[0];
if (!page) page = await context.newPage();

page.on('console', (msg) => console.log('CONSOLE:', msg.type(), msg.text()));
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const root = await page.locator('#root').innerHTML().catch((e) => `error: ${e.message}`);
console.log('--- ROOT HTML ---');
console.log(root);
console.log('--- end ---');
await browser.close();
try { process.kill(child.pid, 'SIGTERM'); } catch {}
