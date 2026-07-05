// smoke-gol-318.mjs — verify worktree identity fix (gitdir remap)
// Creates a temp repo OUTSIDE golem, adds a worktree, asserts resolver behaviour, self-cleans.
import { resolveProjectRoot, projectIdFor } from '../../lib/project-id.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const log = (...a) => console.log('[318]', ...a);

const tmpBase = path.join(os.tmpdir(), `gol-318-smoke-${Date.now()}`);
const mainDir = path.join(tmpBase, 'main');
const worktreeDir = path.join(tmpBase, 'wt-smoke-test');

let ok = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) { ok++; log(`✓ ${label}`); }
  else { fail++; log(`✗ ${label}`); }
}

async function run() {
  // 1. Create temp repo with CLAUDE.md committed
  fs.mkdirSync(mainDir, { recursive: true });
  execSync('git init', { cwd: mainDir, stdio: 'pipe' });
  execSync('git config user.email "smoke@test"', { cwd: mainDir, stdio: 'pipe' });
  execSync('git config user.name "Smoke Test"', { cwd: mainDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(mainDir, 'CLAUDE.md'), '# Test repo\n');
  execSync('git add CLAUDE.md', { cwd: mainDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: mainDir, stdio: 'pipe' });
  log('temp repo created:', mainDir);

  // 2. Add a worktree
  execSync(`git worktree add --detach "${worktreeDir}" main`, { cwd: mainDir, stdio: 'pipe' });
  log('worktree added:', worktreeDir);

  // Verify .git is a file in the worktree
  const gitPath = path.join(worktreeDir, '.git');
  assert(fs.statSync(gitPath).isFile(), '.git is a file (worktree indicator)');

  // 3. resolveProjectRoot(worktreePath) → main root
  const resolved = await resolveProjectRoot(worktreeDir);
  assert(fs.realpathSync(resolved) === fs.realpathSync(mainDir), `resolveProjectRoot(worktree) → main root (got: ${resolved})`);

  // 4. resolveProjectRoot(mainDir) → main root (normal checkout unchanged)
  const resolvedMain = await resolveProjectRoot(mainDir);
  assert(fs.realpathSync(resolvedMain) === fs.realpathSync(mainDir), `resolveProjectRoot(main) → main root (got: ${resolvedMain})`);

  // 5. projectIdFor output unchanged for normal checkout
  const id1 = projectIdFor(mainDir);
  const id2 = projectIdFor(mainDir);
  assert(id1 === id2, `projectIdFor stable: ${id1}`);

  // 6. projectIdFor from worktree (via resolveProjectRoot) matches main
  const idFromWorktree = projectIdFor(fs.realpathSync(await resolveProjectRoot(worktreeDir)));
  const idFromMain = projectIdFor(fs.realpathSync(mainDir));
  assert(idFromWorktree === idFromMain, `projectIdFor(resolveProjectRoot(worktree)) === projectIdFor(main) (${idFromWorktree})`);

  // 7. Cleanup
  execSync(`git worktree remove "${worktreeDir}"`, { cwd: mainDir, stdio: 'pipe' });
  log('worktree removed');
  fs.rmSync(tmpBase, { recursive: true, force: true });
  log('temp repo cleaned up:', tmpBase);

  // Summary
  log(`--- ${ok} passed, ${fail} failed ---`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  // Best-effort cleanup
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});
