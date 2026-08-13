export const PROVIDER_MATCHERS = [
  { id: 'ollama', label: 'Ollama', pattern: /^(?:ollama)$/i, aliases: ['ollama-cloud'] },
  { id: 'openai', label: 'OpenAI', pattern: /^(gpt|o[0-9])/i, aliases: ['openai-codex'] },
  { id: 'anthropic', label: 'Anthropic', pattern: /^claude/i },
  { id: 'minimax', label: 'MiniMax', pattern: /^minimax/i },
  { id: 'z-ai', label: 'Z.ai', pattern: /^glm/i },
  // Claude Code normally reports the bare model id. Ollama-compatible tools
  // can retain an `ollama/` or `ollama:` qualifier, so accept both forms.
  { id: 'deepseek', label: 'DeepSeek', pattern: /^(?:ollama[/:])?deepseek/i },
  { id: 'gemma', label: 'Gemma', pattern: /^gemma/i },
  { id: 'google', label: 'Google', pattern: /^gemini/i },
  { id: 'tencent', label: 'Tencent', pattern: /^hy3/i },
  { id: 'grok', label: 'Grok', pattern: /^grok/i, aliases: ['xai'] },
  { id: 'qwen', label: 'Qwen', pattern: /^qwen/i },
];

export const FALLBACK = { id: 'fallback', label: 'Unknown', pattern: /.^/ };

export function providerForId(provider, providers = PROVIDER_MATCHERS) {
  const id = typeof provider === 'string' ? provider.trim() : '';
  if (!id) return null;
  const needle = id.toLowerCase();
  return providers.find((entry) => entry.id.toLowerCase() === needle
    || (entry.aliases || []).some((alias) => alias.toLowerCase() === needle)) || null;
}

export function providerForModel(model, providers = PROVIDER_MATCHERS) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return FALLBACK;
  return providers.find((entry) => entry.pattern.test(id)) || FALLBACK;
}

export function resolveProvider(provider, model, providers = PROVIDER_MATCHERS) {
  const byModel = providerForModel(model, providers);
  if (byModel && byModel.id !== 'fallback') return byModel;
  return providerForId(provider, providers) || FALLBACK;
}
