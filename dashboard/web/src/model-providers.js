(function () {
  const LOBEHUB_ICONS_VER = '1.91.0';
  const base = `https://unpkg.com/@lobehub/icons-static-svg@${LOBEHUB_ICONS_VER}/icons/`;
  const providers = [
    { id: 'openai', label: 'OpenAI', pattern: /^(gpt|o[0-9])/i, iconSrc: `${base}OpenAI.svg` },
    { id: 'anthropic', label: 'Anthropic', pattern: /^claude/i, iconSrc: `${base}Anthropic.svg` },
    { id: 'minimax', label: 'MiniMax', pattern: /^minimax/i, iconSrc: `${base}Minimax.svg` },
    { id: 'z-ai', label: 'Z.ai', pattern: /^glm/i, iconSrc: `${base}Zai.svg` },
    { id: 'deepseek', label: 'DeepSeek', pattern: /^deepseek/i, iconSrc: `${base}DeepSeek.svg` },
    { id: 'google', label: 'Google', pattern: /^gemini/i, iconSrc: `${base}Gemini.svg` },
  ];
  const fallback = { id: 'fallback', label: 'Unknown', pattern: /.^/, iconSrc: null };

  function providerForModel(model) {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return fallback;
    return providers.find((p) => p.pattern.test(id)) || fallback;
  }

  window.ModelProviders = { providers, fallback, providerForModel };
})();
