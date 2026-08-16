#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-t1-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const capture = path.join(temp, 'pi-launch.json');
const render = path.join(state, 'renders', 'pi', 'golem.ts');
const originalEnv = {
  GOLEM_HOME: process.env.GOLEM_HOME,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  GOLEM_PI_CAPTURE: process.env.GOLEM_PI_CAPTURE,
  GOLEM_DASHBOARD_URL: process.env.GOLEM_DASHBOARD_URL,
};

fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.dirname(render), { recursive: true });
fs.writeFileSync(render, '// test bridge placeholder\n');
const fakePi = path.join(bin, 'pi');
fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n');
  process.exit(0);
}
fs.writeFileSync(process.env.GOLEM_PI_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }, null, 2));
process.exit(0);
`, { mode: 0o700 });

Object.assign(process.env, {
  GOLEM_HOME: state,
  HOME: path.join(temp, 'home'),
  PATH: `${bin}${path.delimiter}${originalEnv.PATH ?? ''}`,
  GOLEM_PI_CAPTURE: capture,
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
});

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    env: { ...process.env },
    encoding: 'utf8',
  });
}

function capturedArgs() {
  return JSON.parse(fs.readFileSync(capture, 'utf8')).args;
}

try {
  const {
    createRole,
    readRoleRegistry,
    updateRoleExec,
  } = await import('../lib/session-role.js');
  const {
    GLOBAL_ROLE_EXEC_DEFAULTS,
    resolveRoleExecution,
    resolveRolePreset,
    validateRolePreset,
  } = await import('../lib/role-preset.js');

  const seeded = readRoleRegistry();
  for (const role of ['builder', 'explorer', 'reviewer']) {
    assert.deepEqual(seeded.find((row) => row.name === role)?.exec, {
      harness: 'pi',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:0731',
      thinking: 'medium',
      name: null,
    });
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'roles', 'index.json'), 'utf8')).roles
    .find((row) => row.name === 'explorer').exec, seeded.find((row) => row.name === 'explorer').exec);
  assert.deepEqual(GLOBAL_ROLE_EXEC_DEFAULTS, { harness: 'pi', provider: 'ollama-cloud' });

  assert.deepEqual(resolveRolePreset('explorer'), [
    '--provider', 'ollama-cloud',
    '--model', 'deepseek-v4-flash:0731',
    '--thinking', 'medium',
  ]);
  assert.deepEqual(resolveRolePreset('explorer', { thinking: 'max' }).slice(-2), ['--thinking', 'max']);

  createRole({
    name: 'preset',
    exec: {
      provider: 'role-provider',
      model: 'role-model',
      thinking: 'low',
      name: 'role-session',
    },
  });
  assert.deepEqual(resolveRoleExecution('preset'), {
    harness: 'pi',
    provider: 'role-provider',
    model: 'role-model',
    thinking: 'low',
    name: 'role-session',
  });
  assert.deepEqual(resolveRoleExecution('preset', {
    provider: 'flag-provider',
    model: 'flag-model',
    thinking: 'max',
    name: 'flag-session',
  }), {
    harness: 'pi',
    provider: 'flag-provider',
    model: 'flag-model',
    thinking: 'max',
    name: 'flag-session',
  });
  updateRoleExec('preset', { thinking: 'high' });
  assert.equal(resolveRoleExecution('preset').thinking, 'high');

  assert.deepEqual(validateRolePreset({ model: 'model-only', thinking: 'medium' }), {
    harness: 'pi',
    provider: 'ollama-cloud',
    model: 'model-only',
    thinking: 'medium',
    name: null,
  });
  assert.throws(() => validateRolePreset({ harness: 'claude', provider: 'p', model: 'm', thinking: 'medium' }, { applyDefaults: false }), /harness must be "pi"/);
  assert.throws(() => validateRolePreset({ harness: 'pi', provider: 'p', model: 'm', thinking: 'invalid' }, { applyDefaults: false }), /thinking must be one of/);
  assert.throws(() => validateRolePreset({ harness: 'pi', provider: null, model: 'm', thinking: 'medium' }, { applyDefaults: false }), /provider is required/);
  assert.throws(() => validateRolePreset({ harness: 'pi', provider: 'p', model: null, thinking: 'medium' }, { applyDefaults: false }), /model is required/);
  assert.throws(() => resolveRolePreset('unknown-role'), /unknown role/);

  const explorerLaunch = run(['pi', '--role', 'explorer']);
  assert.equal(explorerLaunch.status, 0, explorerLaunch.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--provider', 'ollama-cloud',
    '--model', 'deepseek-v4-flash:0731',
    '--thinking', 'medium',
  ]);

  const explicitThinking = run(['pi', '--role', 'explorer', '--thinking', 'max']);
  assert.equal(explicitThinking.status, 0, explicitThinking.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--provider', 'ollama-cloud',
    '--model', 'deepseek-v4-flash:0731',
    '--thinking', 'max',
  ]);

  const explicitAll = run([
    'pi', '--role', 'preset', '--provider', 'flag-provider', '--model', 'flag-model',
    '--thinking', 'max', '--name', 'golemtest-t1-custom',
  ]);
  assert.equal(explicitAll.status, 0, explicitAll.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--provider', 'flag-provider',
    '--model', 'flag-model',
    '--thinking', 'max',
    '--name', 'golemtest-t1-custom',
  ]);

  const bare = run(['pi', '--thinking', 'high', 'prompt with spaces']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--thinking', 'high', 'prompt with spaces',
  ], 'bare golem pi keeps native passthrough behavior');

  const unknown = run(['pi', '--role', 'unknown-role']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown role/);
  assert.doesNotMatch(unknown.stderr, /at file:/);

  updateRoleExec('preset', { thinking: 'invalid' });
  const badThinking = run(['pi', '--role', 'preset']);
  assert.equal(badThinking.status, 2);
  assert.match(badThinking.stderr, /thinking must be one of/);
  assert.doesNotMatch(badThinking.stderr, /at file:/);

  updateRoleExec('preset', { thinking: 'medium', harness: 'claude' });
  const badHarness = run(['pi', '--role', 'preset']);
  assert.equal(badHarness.status, 2);
  assert.match(badHarness.stderr, /harness must be "pi"/);

  const modelWithoutProvider = run(['pi', '--model', 'model-only']);
  assert.equal(modelWithoutProvider.status, 2);
  assert.match(modelWithoutProvider.stderr, /requires --provider and --model together/);

  console.log('Role preset journey passed: seeded registry, global defaults, precedence, validation, composed Pi argv, and bare-launch compatibility');
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
