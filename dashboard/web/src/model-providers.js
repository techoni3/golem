(function () {
  const providers = [
    { id: 'openai', label: 'OpenAI', pattern: /^(gpt|o[0-9])/i, initials: 'OA' },
    { id: 'anthropic', label: 'Anthropic', pattern: /^claude/i, initials: 'AN' },
    { id: 'minimax', label: 'MiniMax', pattern: /^minimax/i, initials: 'MM' },
    { id: 'z-ai', label: 'Z.ai', pattern: /^glm/i, initials: 'ZA' },
    { id: 'deepseek', label: 'DeepSeek', pattern: /^deepseek/i, initials: 'DS' },
    { id: 'gemma', label: 'Gemma', pattern: /^gemma/i, initials: 'GE' },
    { id: 'google', label: 'Google', pattern: /^gemini/i, initials: 'GO' },
    { id: 'tencent', label: 'Tencent', pattern: /^hy3/i, initials: 'TC' },
  ];
  const fallback = { id: 'fallback', label: 'Unknown', pattern: /.^/, initials: 'AI' };

  function providerForModel(model) {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return fallback;
    return providers.find((p) => p.pattern.test(id)) || fallback;
  }

  window.ModelProviders = { providers, fallback, providerForModel };
})();
