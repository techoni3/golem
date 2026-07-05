(function () {
  const base = '/assets/ai-provider-icons/';
  const providers = [
    { id: 'openai', label: 'OpenAI', pattern: /^(gpt|o[0-9])/i, iconSrc: `${base}openai.svg` },
    { id: 'anthropic', label: 'Anthropic', pattern: /^claude/i, iconSrc: `${base}claude-color.svg` },
    { id: 'minimax', label: 'MiniMax', pattern: /^minimax/i, iconSrc: `${base}minimax-color.svg` },
    { id: 'google', label: 'Google', pattern: /^gemini/i, iconSrc: `${base}gemini-color.svg` },
  ];
  const fallback = { id: 'fallback', label: 'Unknown', pattern: /.^/, iconSrc: null };

  function providerForModel(model) {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return fallback;
    return providers.find((p) => p.pattern.test(id)) || fallback;
  }

  window.ModelProviders = { providers, fallback, providerForModel };
})();
