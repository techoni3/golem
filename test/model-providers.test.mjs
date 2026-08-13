import assert from 'node:assert/strict';
import test from 'node:test';
import {
  providerForId,
  providerForModel,
  resolveProvider,
} from '../dashboard/web/src/model-provider-match.mjs';

test('harness-adjacent provider ids alias onto the family icon', () => {
  assert.equal(providerForId('openai-codex')?.id, 'openai');
  assert.equal(providerForId('xai')?.id, 'grok');
  assert.equal(providerForId('ollama-cloud')?.id, 'ollama');
  assert.equal(providerForId('unknown-host'), null);
});

test('model ids used under Pi resolve to the family icon', () => {
  assert.equal(providerForModel('gpt-5.6-luna').id, 'openai');
  assert.equal(providerForModel('grok-4.6').id, 'grok');
  assert.equal(providerForModel('deepseek-v4-flash:0731-cloud').id, 'deepseek');
  assert.equal(providerForModel('gemma4:26b-mlx').id, 'gemma');
  assert.equal(providerForModel('qwen3.6:27b-mlx').id, 'qwen');
});

test('unknown transport ids do not hide a known model family', () => {
  assert.equal(resolveProvider('openai-codex', 'gpt-5.6-luna').id, 'openai');
  assert.equal(resolveProvider('xai', 'grok-4.6').id, 'grok');
  assert.equal(resolveProvider('ollama', 'deepseek-v4-flash:0731-cloud').id, 'deepseek');
  assert.equal(resolveProvider('ollama', 'qwen3.6:27b-mlx').id, 'qwen');
  assert.equal(resolveProvider('ollama', 'gemma4:12b-mlx').id, 'gemma');
  assert.equal(resolveProvider('omlx', 'Muse-Glimmer-30B-4bit').id, 'fallback');
});
