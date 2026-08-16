import {
  getRole,
  readRoleRegistry,
  ROLE_EXEC_DEFAULTS,
  THINKING_LEVELS,
  validateRolePreset,
} from './session-role.js';

export { ROLE_EXEC_DEFAULTS, THINKING_LEVELS, validateRolePreset };

// Descriptive alias for callers that want to make the global scope explicit.
export const GLOBAL_ROLE_EXEC_DEFAULTS = ROLE_EXEC_DEFAULTS;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanOverrides(overrides) {
  if (!isRecord(overrides)) return {};
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
}

/** Resolve a role into its normalized execution attributes. */
export function resolveRoleExecution(role, overrides = {}) {
  const record = getRole(role);
  if (!record) {
    const available = readRoleRegistry().map(({ name }) => name).join(', ');
    throw new Error(`unknown role "${role}"; expected one of: ${available}`);
  }

  const roleExec = record.exec;
  if (!isRecord(roleExec)) {
    const available = readRoleRegistry()
      .filter(({ exec }) => isRecord(exec))
      .map(({ name }) => name);
    throw new Error(`role "${record.name}" has no execution preset; roles with presets: ${available.join(', ') || '(none)'}`);
  }
  const merged = {
    ...ROLE_EXEC_DEFAULTS,
    ...roleExec,
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
