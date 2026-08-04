import anthropicIcon from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode-color.svg?url';
import codexIcon from '@lobehub/icons-static-svg/icons/codex-color.svg?url';
import deepSeekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import gemmaIcon from '@lobehub/icons-static-svg/icons/gemma-color.svg?url';
import minimaxIcon from '@lobehub/icons-static-svg/icons/minimax-color.svg?url';
import openAiIcon from '@lobehub/icons-static-svg/icons/openai.svg?url';
import openCodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import tencentIcon from '@lobehub/icons-static-svg/icons/tencent-color.svg?url';
import zaiIcon from '@lobehub/icons-static-svg/icons/zai.svg?url';

(function () {
  const providers = [
    { id: 'openai', label: 'OpenAI', pattern: /^(gpt|o[0-9])/i, iconSrc: openAiIcon },
    { id: 'anthropic', label: 'Anthropic', pattern: /^claude/i, iconSrc: anthropicIcon },
    { id: 'minimax', label: 'MiniMax', pattern: /^minimax/i, iconSrc: minimaxIcon },
    { id: 'z-ai', label: 'Z.ai', pattern: /^glm/i, iconSrc: zaiIcon },
    // Claude Code normally reports the bare model id. Ollama-compatible tools
    // can retain an `ollama/` or `ollama:` qualifier, so accept both forms.
    { id: 'deepseek', label: 'DeepSeek', pattern: /^(?:ollama[/:])?deepseek/i, iconSrc: deepSeekIcon },
    { id: 'gemma', label: 'Gemma', pattern: /^gemma/i, iconSrc: gemmaIcon },
    { id: 'google', label: 'Google', pattern: /^gemini/i, iconSrc: geminiIcon },
    { id: 'tencent', label: 'Tencent', pattern: /^hy3/i, iconSrc: tencentIcon },
  ];
  const fallback = { id: 'fallback', label: 'Unknown', pattern: /.^/, iconSrc: null };
  const harnesses = {
    claudecode: { id: 'claudecode', label: 'Claude Code', iconSrc: claudeCodeIcon },
    opencode: { id: 'opencode', label: 'OpenCode', iconSrc: openCodeIcon },
    codex: { id: 'codex', label: 'Codex', iconSrc: codexIcon },
  };

  function providerForModel(model) {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return fallback;
    return providers.find((p) => p.pattern.test(id)) || fallback;
  }

  function harnessForId(harness) {
    return harnesses[harness] || null;
  }

  window.ModelProviders = { providers, fallback, providerForModel, harnesses, harnessForId };
})();
