import anthropicIcon from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode-color.svg?url';
import codexIcon from '@lobehub/icons-static-svg/icons/codex-color.svg?url';
import deepSeekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import gemmaIcon from '@lobehub/icons-static-svg/icons/gemma-color.svg?url';
import grokIcon from '@lobehub/icons-static-svg/icons/grok.svg?url';
import minimaxIcon from '@lobehub/icons-static-svg/icons/minimax-color.svg?url';
import openAiIcon from '@lobehub/icons-static-svg/icons/openai.svg?url';
import openCodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import ollamaIcon from '@lobehub/icons-static-svg/icons/ollama.svg?url';
import piIcon from '@lobehub/icons-static-svg/icons/pi.svg?url';
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen-color.svg?url';
import tencentIcon from '@lobehub/icons-static-svg/icons/tencent-color.svg?url';
import zaiIcon from '@lobehub/icons-static-svg/icons/zai.svg?url';
import {
  FALLBACK,
  PROVIDER_MATCHERS,
  providerForId as matchProviderForId,
  providerForModel as matchProviderForModel,
  resolveProvider as matchResolveProvider,
} from './model-provider-match.mjs';

(function () {
  const icons = {
    ollama: ollamaIcon,
    openai: openAiIcon,
    anthropic: anthropicIcon,
    minimax: minimaxIcon,
    'z-ai': zaiIcon,
    deepseek: deepSeekIcon,
    gemma: gemmaIcon,
    google: geminiIcon,
    tencent: tencentIcon,
    grok: grokIcon,
    qwen: qwenIcon,
  };
  const providers = PROVIDER_MATCHERS.map((entry) => ({
    ...entry,
    iconSrc: icons[entry.id] || null,
  }));
  const fallback = { ...FALLBACK, iconSrc: null };
  const harnesses = {
    claudecode: { id: 'claudecode', label: 'Claude Code', iconSrc: claudeCodeIcon },
    opencode: { id: 'opencode', label: 'OpenCode', iconSrc: openCodeIcon },
    codex: { id: 'codex', label: 'Codex', iconSrc: codexIcon },
    pi: { id: 'pi', label: 'Pi', iconSrc: piIcon },
  };

  function withIcon(entry) {
    if (!entry) return entry;
    if (entry.id === 'fallback') return fallback;
    return { ...entry, iconSrc: icons[entry.id] || null };
  }

  function providerForId(provider) {
    return withIcon(matchProviderForId(provider));
  }

  function providerForModel(model) {
    return withIcon(matchProviderForModel(model));
  }

  function resolveProvider(provider, model) {
    return withIcon(matchResolveProvider(provider, model));
  }

  function harnessForId(harness) {
    return harnesses[harness] || null;
  }

  window.ModelProviders = {
    providers,
    fallback,
    providerForId,
    providerForModel,
    resolveProvider,
    harnesses,
    harnessForId,
  };
})();
