#!/usr/bin/env node
// Regenerate the pinned Codex App Server schema contract from the installed CLI.
//
// The contract exists because golem drives the App Server protocol directly
// (thread/start, thread/resume, turn/start, turn/steer, approvals) and that
// protocol is explicitly experimental. When OpenAI reshapes it, golem must fail
// loudly at startup rather than send silently-wrong frames.
//
// Updating it is a REVIEW step, not a rubber stamp: this script prints which
// leaves changed so a human can check that the surfaces golem actually uses are
// still compatible before pasting the new block in.
//
// Usage:
//   node scripts/regen-codex-contract.mjs            # report drift only
//   node scripts/regen-codex-contract.mjs --write    # rewrite the contract file

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_APP_SERVER_CONTRACT } from '../lib/codex-app-server-contract.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractFile = path.join(repoRoot, 'lib', 'codex-app-server-contract.js');
const write = process.argv.includes('--write');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function codexVersion() {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`codex --version failed: ${result.stderr || result.error?.message}`);
    process.exit(2);
  }
  const match = `${result.stdout}${result.stderr}`.match(/codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) { console.error('could not parse codex-cli version'); process.exit(2); }
  return match[1];
}

const version = codexVersion();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-schema-'));
try {
  const gen = spawnSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', outDir], { encoding: 'utf8' });
  if (gen.status !== 0) {
    console.error(`schema generation failed: ${gen.stderr || gen.error?.message}`);
    process.exit(2);
  }

  const changed = [];
  const missing = [];
  const observed = [];
  for (const [rel, pinned] of Object.entries(CODEX_APP_SERVER_CONTRACT.schemaFiles)) {
    const abs = path.join(outDir, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    const actual = sha256(fs.readFileSync(abs));
    observed.push([rel, actual]);
    if (actual !== pinned) changed.push(rel);
  }
  observed.sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = sha256(JSON.stringify(observed));

  console.log(`installed codex-cli:  ${version}`);
  console.log(`contract verified at: ${CODEX_APP_SERVER_CONTRACT.verifiedAgainstCliVersion ?? CODEX_APP_SERVER_CONTRACT.cliVersion}`);
  console.log(`leaves: ${observed.length} tracked, ${changed.length} changed, ${missing.length} missing`);
  if (missing.length) {
    console.log('');
    console.log('MISSING — the CLI no longer emits these. Golem may depend on them:');
    for (const rel of missing) console.log(`  ${rel}`);
  }
  if (changed.length) {
    console.log('');
    console.log('CHANGED — review each against how golem uses it before accepting:');
    for (const rel of changed) console.log(`  ${rel}`);
  }
  console.log('');
  console.log(`fingerprint: ${fingerprint}`);

  if (!write) {
    console.log('');
    console.log(changed.length || missing.length
      ? 'run again with --write to pin these, after reviewing the list above'
      : 'contract is current; nothing to write');
    process.exit(changed.length || missing.length ? 1 : 0);
  }

  if (missing.length) {
    console.error('');
    console.error('refusing to write: schemas golem tracks are missing from this CLI.');
    process.exit(2);
  }

  const body = fs.readFileSync(contractFile, 'utf8');
  const leaves = observed.map(([rel, hash]) => `    '${rel}': '${hash}',`).join('\n');
  const block = `export const CODEX_APP_SERVER_CONTRACT = Object.freeze({\n`
    + `  verifiedAgainstCliVersion: '${version}',\n`
    + `  schemaFingerprint: '${fingerprint}',\n`
    + `  schemaFiles: Object.freeze({\n${leaves}\n  }),\n});`;
  const replaced = body.replace(/export const CODEX_APP_SERVER_CONTRACT = Object\.freeze\(\{[\s\S]*?\n\}\);/, block);
  if (replaced === body) {
    console.error('could not locate the contract block to replace');
    process.exit(2);
  }
  fs.writeFileSync(contractFile, replaced);
  console.log(`wrote ${path.relative(repoRoot, contractFile)} (verified against ${version})`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
