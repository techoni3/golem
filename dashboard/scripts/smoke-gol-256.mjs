import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-gol-256-'));
const home = path.join(tmp, 'home');
const xdg = path.join(tmp, 'xdg');
const golemHome = path.join(tmp, 'golem-home');
const substrate = path.join(tmp, 'substrate');
const instructions = path.join(substrate, 'instructions', 'AGENTS.md');
const ccDest = path.join(home, '.claude', 'CLAUDE.md');
const ocDest = path.join(xdg, 'opencode', 'AGENTS.md');
const begin = '<!-- golem:instructions:begin -->';
const end = '<!-- golem:instructions:end -->';

function cpDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function run(args, { ok = true } = {}) {
  const res = spawnSync(process.execPath, ['./cli/golem.js', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GOLEM_HOME: golemHome,
      GOLEM_SUBSTRATE_ROOT: substrate,
    },
  });
  if (ok && res.status !== 0) {
    throw new Error(`command failed: node ./cli/golem.js ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  if (!ok && res.status === 0) {
    throw new Error(`command unexpectedly passed: node ./cli/golem.js ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  return res;
}

function managedInner(file) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  assert.ok(start >= 0 && stop > start, `${file} has managed markers`);
  let innerStart = start + begin.length;
  if (text.startsWith('\r\n', innerStart)) innerStart += 2;
  else if (text.startsWith('\n', innerStart)) innerStart += 1;
  return text.slice(innerStart, stop);
}

fs.mkdirSync(path.dirname(instructions), { recursive: true });
cpDir(path.join(repo, 'substrate', 'skills'), path.join(substrate, 'skills'));
cpDir(path.join(repo, 'substrate', 'agents'), path.join(substrate, 'agents'));
cpDir(path.join(repo, 'substrate', 'hooks'), path.join(substrate, 'hooks'));
cpDir(path.join(repo, 'substrate', 'roles'), path.join(substrate, 'roles'));
for (const name of ['mcp.json', 'plugin-meta.json', 'README.md']) fs.copyFileSync(path.join(repo, 'substrate', name), path.join(substrate, name));
fs.writeFileSync(instructions, 'alpha\n{{#if claudecode}}cc-only\n{{/if}}{{#if opencode}}oc-only\n{{/if}}');
fs.mkdirSync(golemHome, { recursive: true });
fs.writeFileSync(path.join(golemHome, 'config.json'), JSON.stringify({ harnesses: { claudecode: { enabled: true }, opencode: { enabled: true } } }, null, 2));

// Initial migration path: force is required for an existing unmarked file and
// creates missing destinations containing only the managed block.
fs.mkdirSync(path.dirname(ccDest), { recursive: true });
fs.writeFileSync(ccDest, 'pre-existing personal text\n');
run(['sync', '--target', 'cc', '--force']);
run(['sync', '--target', 'opencode', '--force']);
assert.equal(fs.readFileSync(ccDest, 'utf8').startsWith(begin), true, 'force seed overwrites unmarked CC file with block-only file');
assert.equal(fs.readFileSync(ocDest, 'utf8').startsWith(begin), true, 'missing opencode destination created with block-only file');
assert.match(managedInner(ccDest), /cc-only/);
assert.doesNotMatch(managedInner(ccDest), /oc-only/);
assert.match(managedInner(ocDest), /oc-only/);
assert.doesNotMatch(managedInner(ocDest), /cc-only/);

// Source edits update both managed blocks while outside-marker text survives.
fs.appendFileSync(ccDest, 'personal cc suffix\n');
fs.appendFileSync(ocDest, 'personal oc suffix\n');
fs.writeFileSync(instructions, 'beta\n{{#if claudecode}}cc-only-v2\n{{/if}}{{#if opencode}}oc-only-v2\n{{/if}}');
run(['sync', '--target', 'cc']);
run(['sync', '--target', 'opencode']);
assert.match(managedInner(ccDest), /beta\ncc-only-v2/);
assert.match(managedInner(ocDest), /beta\noc-only-v2/);
assert.match(fs.readFileSync(ccDest, 'utf8'), /personal cc suffix/);
assert.match(fs.readFileSync(ocDest, 'utf8'), /personal oc suffix/);

// Outside edits alone do not drift; managed-block edits do.
run(['sync', '--target', 'cc', '--check']);
run(['sync', '--target', 'opencode', '--check']);
fs.writeFileSync(ccDest, fs.readFileSync(ccDest, 'utf8').replace('beta', 'tampered-beta'));
const ccCheck = run(['sync', '--target', 'cc', '--check'], { ok: false });
assert.match(ccCheck.stdout + ccCheck.stderr, /tampered\s+instructions:AGENTS\.md/);
const ccPlain = run(['sync', '--target', 'cc'], { ok: false });
assert.match(ccPlain.stdout + ccPlain.stderr, /golem:instructions block/);
assert.match(ccPlain.stdout + ccPlain.stderr, /--force/);
run(['sync', '--target', 'cc', '--force']);

// Mangled markers are also guarded, and force recovers.
fs.writeFileSync(ocDest, fs.readFileSync(ocDest, 'utf8').replace(begin, '<!-- golem:instructions:BEGIN -->'));
const ocPlain = run(['sync', '--target', 'opencode'], { ok: false });
assert.match(ocPlain.stdout + ocPlain.stderr, /expected exactly one/);
run(['sync', '--target', 'opencode', '--force']);

console.log(JSON.stringify({
  ok: true,
  tmp,
  cc_dest: ccDest,
  opencode_dest: ocDest,
  cc_inner: managedInner(ccDest).trim(),
  opencode_inner: managedInner(ocDest).trim(),
}, null, 2));
