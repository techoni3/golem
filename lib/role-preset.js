import { getRole, readRoleRegistry } from './session-role.js';

export const THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

// These defaults are deliberately global. Per-project execution overrides are
// out of scope for the Pi worker launch contract.
export const ROLE_EXEC_DEFAULTS = Object.freeze({
  harness: 'pi',
  provider: 'ollama-cloud',
});

// Descriptive alias for callers that want to make the global scope explicit.
export const GLOBAL_ROLE_EXEC_DEFAULTS = ROLE_EXEC_DEFAULTS;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function presetPrefix(role) {
  return role ? `invalid role preset for "${role}"` : 'invalid role preset';
}

function fail(role, message) {
  throw new Error(`${presetPrefix(role)}: ${message}`);
}

function cleanOverrides(overrides) {
  if (!isRecord(overrides)) return {};
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
}

/**
 * Validate and normalize one resolved execution preset.
 *
 * The global defaults are applied here so the same validator can be used by
 * the CLI and by the dashboard's future preset editor. A caller can disable
 * that merge when it needs to validate a raw, standalone role block.
 */
export function validateRolePreset(preset, { role = null, applyDefaults = true } = {}) {
  if (!isRecord(preset)) fail(role, 'exec must be an object');
  const candidate = applyDefaults ? { ...ROLE_EXEC_DEFAULTS, ...preset } : { ...preset };

  if (candidate.harness !== 'pi') {
    fail(role, `harness must be "pi" (got ${JSON.stringify(candidate.harness)})`);
  }

  if (typeof candidate.provider !== 'string' || !candidate.provider.trim()) {
    fail(role, 'provider is required when a model is configured');
  }
  if (typeof candidate.model !== 'string' || !candidate.model.trim()) {
    fail(role, 'model is required');
  }
  if (!THINKING_LEVELS.includes(candidate.thinking)) {
    fail(role, `thinking must be one of ${THINKING_LEVELS.join(', ')} (got ${JSON.stringify(candidate.thinking)})`);
  }

  let name = null;
  if (candidate.name != null) {
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
      fail(role, 'name must be a non-empty string when supplied');
    }
    name = candidate.name.trim();
  }

  return {
    harness: candidate.harness,
    provider: candidate.provider.trim(),
    model: candidate.model.trim(),
    thinking: candidate.thinking,
    name,
  };
}

/** Resolve a role into its normalized execution attributes. */
export function resolveRoleExecution(role, overrides = {}) {
  const record = getRole(role);
  if (!record) {
    const available = readRoleRegistry().map(({ name }) => name).join(', ');
    throw new Error(`unknown role "${role}"; expected one of: ${available}`);
  }

  const roleExec = record.exec;
  const merged = {
    ...ROLE_EXEC_DEFAULTS,
    ...(isRecord(roleExec) ? roleExec : { exec: roleExec }),
    ...cleanOverrides(overrides),
  };
  return validateRolePreset(merged, { role: record.name, applyDefaults: false });
}

/**
 * Resolve a role into the Pi argv fragment owned by golem.
 *
 * The returned order is stable: provider, model, thinking, then optional name.
 * `harness` is validated but is not emitted because Pi is the only supported
 * harness in this contract.
 */
export function resolveRolePreset(role, overrides = {}) {
  const exec = resolveRoleExecution(role, overrides);
  return [
    '--provider', exec.provider,
    '--model', exec.model,
    '--thinking', exec.thinking,
    ...(exec.name ? ['--name', exec.name] : []),
  ];
}
