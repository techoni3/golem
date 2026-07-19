import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

test('the stack certification refuses to certify an ineligible Node/npm pair', () => {
  const result = spawnSync(process.execPath, [runner, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, 1);
  assert.equal(report.overall, 'FAIL');
  assert.equal(result.status, 1);
  assert.equal(report.rows.length, 9);
  for (const row of report.rows) {
    assert.equal(row.status, 'FAIL');
    assert.match(row.evidence, /requires Node >=24\.18\.0 <25 and npm 11\.16\.0/);
  }
  assert.deepEqual(report.platform_matrix.map((row) => row.id), ['darwin-arm64', 'darwin-x64']);
});
