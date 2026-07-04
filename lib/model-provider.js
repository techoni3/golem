export const MODEL_PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    pattern: /^(gpt|o[0-9])/i,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 5.5v13M5.5 12h13M7.4 7.4l9.2 9.2M16.6 7.4l-9.2 9.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    pattern: /^claude/i,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 21 20H3L12 4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 9.2 16.3 17H7.7L12 9.2Z" fill="currentColor"/></svg>',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    pattern: /^minimax/i,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 15V9l4 4 4-4v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'z.ai',
    label: 'Z.ai',
    pattern: /^glm/i,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14L7 18h12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="6" r="2" fill="currentColor"/></svg>',
  },
  {
    id: 'google',
    label: 'Google',
    pattern: /^gemini/i,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  },
];

export const FALLBACK_MODEL_PROVIDER = {
  id: 'fallback',
  label: 'Unknown',
  pattern: /.^/,
  icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.5 9a2.7 2.7 0 1 1 4.1 2.3c-.9.6-1.6 1.2-1.6 2.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>',
};

export function providerForModel(model) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return FALLBACK_MODEL_PROVIDER;
  return MODEL_PROVIDERS.find((p) => p.pattern.test(id)) ?? FALLBACK_MODEL_PROVIDER;
}
