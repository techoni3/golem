(function () {
  const LOBEHUB_ICONS_VER = '1.91.0';
  const iconBase = `https://unpkg.com/@lobehub/icons-static-svg@${LOBEHUB_ICONS_VER}/icons/`;
  const providers = [
    { id: 'openai', label: 'OpenAI', pattern: /^(gpt|o[0-9])/i, iconSrc: `${iconBase}openai.svg` },
    { id: 'anthropic', label: 'Anthropic', pattern: /^claude/i, iconSrc: `${iconBase}claude-color.svg` },
    { id: 'minimax', label: 'MiniMax', pattern: /^minimax/i, iconSrc: `${iconBase}minimax-color.svg` },
    { id: 'z-ai', label: 'Z.ai', pattern: /^glm/i, iconSrc: `${iconBase}zai.svg` },
    { id: 'deepseek', label: 'DeepSeek', pattern: /^deepseek/i, iconSrc: `${iconBase}deepseek-color.svg` },
    { id: 'gemma', label: 'Gemma', pattern: /^gemma/i, iconSrc: `${iconBase}gemma-color.svg` },
    { id: 'google', label: 'Google', pattern: /^gemini/i, iconSrc: `${iconBase}gemini-color.svg` },
    { id: 'tencent', label: 'Tencent', pattern: /^hy3/i, iconSrc: `${iconBase}tencent-color.svg` },
  ];
  const fallback = { id: 'fallback', label: 'Unknown', pattern: /.^/, iconSrc: null };

  function providerForModel(model) {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return fallback;
    return providers.find((p) => p.pattern.test(id)) || fallback;
  }

  window.ModelProviders = { iconBase, providers, fallback, providerForModel };
})();
