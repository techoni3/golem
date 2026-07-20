import assert from 'node:assert/strict';

// Keep this explicit allow-list intentionally small.  In particular, do not
// begin from process.env and delete known keys: a newly introduced provider
// variable would then become a silent credential leak into a certification
// child.  The parent may have credentials; this helper never copies them.
const SAFE_PARENT_VARIABLES = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];

export const MODEL_PROVIDER_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'VERTEXAI_PROJECT',
  'VERTEX_AI_PROJECT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

/**
 * Return the whole environment for a certification child.  Only mundane
 * process execution locale variables are inherited; HOME, Golem state, and
 * every provider credential/configuration entry are freshly defined.
 */
export function isolatedChildEnv({ home, golemHome, xdgConfigHome, extra = {} }) {
  const env = {};
  for (const key of SAFE_PARENT_VARIABLES) {
    const value = process.env[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    GOLEM_HOME: golemHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    ...extra,
  });
  for (const key of MODEL_PROVIDER_VARIABLES) delete env[key];
  return env;
}

export function assertCredentialFreeChildEnv(env) {
  for (const key of MODEL_PROVIDER_VARIABLES) {
    assert.equal(Object.hasOwn(env, key), false, `certification child must not receive ${key}`);
  }
}
