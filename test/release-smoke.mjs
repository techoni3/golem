import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'golem-release-'));
const packDir = path.join(temp, 'pack');
const installDir = path.join(temp, 'install');
const home = path.join(temp, 'home');
const xdg = path.join(temp, 'xdg');
const env = {
  ...process.env,
  HOME: home,
  GOLEM_HOME: path.join(temp, 'state'),
  XDG_CONFIG_HOME: xdg,
  PORT: '17421',
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:17421',
};

function run(file, args, cwd = temp) {
  return execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
}

try {
  run('mkdir', ['-p', packDir, installDir, home, xdg]);
  const tarballName = run('npm', ['pack', '--pack-destination', packDir], repo).trim().split('\n').at(-1);
  const tarball = path.join(packDir, tarballName);
  run('npm', ['init', '-y'], installDir);
  run('npm', ['install', '--no-audit', '--no-fund', tarball], installDir);

  const installedRequire = createRequire(path.join(installDir, 'package.json'));
  const packageRoot = path.resolve(path.dirname(installedRequire.resolve('@laveesingh/golem')), '..');
  assert.notEqual(packageRoot, repo, 'CLI must resolve from the installed tarball');
  assert.equal(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'))).name, '@laveesingh/golem');
  const cli = path.join(packageRoot, 'cli', 'golem.js');
  run(process.execPath, [cli, 'help'], installDir);
  run(process.execPath, [cli, 'sync', '--target', 'cc'], installDir);
  run(process.execPath, [cli, 'sync', '--target', 'cc-marketplace'], installDir);
  run(process.execPath, [cli, 'sync', '--target', 'opencode'], installDir);

  const renderedChannel = path.join(env.GOLEM_HOME, 'renders', 'cc-plugin', 'mcp', 'channel');
  const channelRequire = createRequire(path.join(renderedChannel, 'index.js'));
  const sdk = channelRequire.resolve('@modelcontextprotocol/sdk/server/index.js');
  assert.ok(realpathSync(sdk).startsWith(realpathSync(renderedChannel)), 'rendered channel SDK must be self-contained');
  assert.equal(JSON.parse(readFileSync(path.join(env.GOLEM_HOME, 'renders', 'cc-plugin', '.claude-plugin', 'plugin.json'))).name, 'golem');
  console.log(`release smoke passed: ${tarballName}`);
  console.log(`installed root: ${packageRoot}`);
  console.log(`rendered channel SDK: ${sdk}`);
  console.log('isolated port: 17421');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
