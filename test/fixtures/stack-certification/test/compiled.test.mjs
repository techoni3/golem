import assert from 'node:assert/strict';
import test from 'node:test';
import { runCertificationMessage } from '@golem-stack/app';

test('compiled Node ESM workspace package exports its typed contract', () => {
  assert.deepEqual(runCertificationMessage({ message: '  node test  ' }), { message: 'node test' });
});
