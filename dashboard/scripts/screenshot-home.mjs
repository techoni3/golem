import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const url = process.argv[2] || 'http://127.0.0.1:7420/';
const out = process.argv[3] || '/tmp/tkt9-home.png';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userDataDir = path.join(os.tmpdir(), 'golem-tkt9-chrome-profile');
const cdpPort = 9223;

// Launch Chrome with a remote-debugging port in the background.
const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    url,
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

// Wait for CDP to come up.
await new Promise((resolve) => setTimeout(resolve, 2500));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: out, fullPage: true });
await browser.close();

// Kill the headless Chrome we spawned.
try { process.kill(child.pid, 'SIGTERM'); } catch {}

console.log('screenshot:', out);
