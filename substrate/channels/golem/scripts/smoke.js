#!/usr/bin/env node
// Smoke test: spawn the channel server, hit /healthz, then exit.
// Note: stdin is left open (and ignored by the MCP transport), since the
// MCP side won't be hooked up to Claude Code in this standalone context —
// we're only verifying the HTTP listener works.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, '..', 'index.js');
const PORT = process.env.GOLEM_CHANNEL_PORT || '7421';
const HOST = '127.0.0.1';

const child = spawn(process.execPath, [INDEX], {
  env: { ...process.env, GOLEM_CHANNEL_PORT: PORT },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let failed = false;
const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  failed = true;
  child.kill('SIGTERM');
};

child.on('error', (err) => fail(`spawn error: ${err.message}`));
child.on('exit', (code, signal) => {
  if (!failed && code !== null && code !== 0) {
    console.error(`[smoke] server exited unexpectedly (code=${code} signal=${signal})`);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
});

async function waitForHealthz(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/healthz`);
      if (res.ok) return res.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('healthz did not respond in time');
}

try {
  const body = await waitForHealthz();
  if (!body || body.ok !== true) {
    fail(`unexpected /healthz body: ${JSON.stringify(body)}`);
  } else {
    console.log(`[smoke] OK — version=${body.version}`);
  }

  // 403 check: missing X-Sender should be rejected.
  const forbidden = await fetch(`http://${HOST}:${PORT}/brief`, {
    method: 'POST',
    body: 'no sender header',
  });
  if (forbidden.status !== 403) {
    fail(`expected 403 for missing X-Sender, got ${forbidden.status}`);
  } else {
    console.log('[smoke] OK — unauthenticated /brief rejected with 403');
  }

  // 202 check: allowed sender accepted (event will be silently dropped since
  // MCP transport isn't connected to a real client, but the HTTP path runs).
  const accepted = await fetch(`http://${HOST}:${PORT}/brief`, {
    method: 'POST',
    headers: { 'X-Sender': 'curl', 'Content-Type': 'text/plain' },
    body: 'hello golem',
  });
  if (accepted.status !== 202) {
    fail(`expected 202 for allowed /brief, got ${accepted.status}`);
  } else {
    console.log('[smoke] OK — authenticated /brief accepted with 202');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  child.kill('SIGTERM');
}
