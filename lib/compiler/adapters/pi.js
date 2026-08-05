// Pi remains product Tier B until the tools/resources/dashboard/release waves
// land, but this adapter ships its native typed-worker delivery primitive.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256File } from '../engine.js';

const PI_ROLES = Object.freeze(['builder', 'explorer', 'reviewer']);
const PI_SKILLS = Object.freeze([
  'browsing', 'building', 'code-survey', 'compare-design-options', 'consulting',
  'docs-maintenance', 'exploring', 'gates', 'git-conventions', 'journaling',
  'reviewing', 'skill-authoring', 'test-policy', 'tracker',
  'transcript-workflow-coach', 'verify-done',
]);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? files(abs) : [abs];
  });
}

function item(key, outputRelPath, source) {
  return { key, outputRelPath, sourceSha256: sha256File(source), build: () => fs.readFileSync(source) };
}

export function buildPlan({ repoRoot, substrateRoot: suppliedSubstrateRoot, packageVersion }) {
  const substrateRoot = suppliedSubstrateRoot || process.env.GOLEM_SUBSTRATE_ROOT || path.join(repoRoot, 'substrate');
  const extension = path.join(repoRoot, 'shims', 'pi', 'golem.ts');
  const capabilities = {
    schema: 1, harness: 'pi', tier: 'B', lifecycle: true, mcp: false, subagents: false,
    native_tools: true, resources: ['instructions', 'roles', 'skills', 'project-context'],
    roles: PI_ROLES,
    delivery: ['typed-worker', 'next_turn_migration'], push_delivery: true, node: '>=22.19',
    limitation: 'Native delivery, Golem tools, and worker resources are available; first-class worker status still requires managed launch, dashboard cutover, and release proof.',
  };
  const pkg = { name: '@laveesingh/golem-pi-extension', version: packageVersion, private: true, type: 'module', pi: { extensions: ['./golem.ts'], skills: ['./skills'] } };
  const readme = '# Golem for Pi (Tier B)\n\nRequires Pi 0.80.10 and Node.js >=22.19. Load without changing a profile:\n\n```sh\nGOLEM_DIR="${GOLEM_HOME:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/golem}}"\n[ -n "$GOLEM_DIR" ] || { [ -d "$HOME/.golem" ] && GOLEM_DIR="$HOME/.golem" || GOLEM_DIR="$HOME/.config/golem"; }\npi -e "$GOLEM_DIR/renders/pi/golem.ts"\n```\n\nThis follows Golem’s canonical GOLEM_HOME/XDG/migrated/legacy resolution when `GOLEM_HOME` is unset. The extension registers the shared Golem tools, supplies Golem-owned instructions plus builder/explorer/reviewer role context at safe turn boundaries, exposes progressively loaded skills, renders bounded project context, and provides authenticated typed-worker delivery. It does not mutate the Pi profile. Product Tier-A promotion remains deferred until the launcher, dashboard, and release-proof slices land.\n';
  const runtime = [
    'golem-home.js', 'project-id.js', 'session-facts.js', 'typed-worker-endpoint.js',
    'typed-delivery-tombstones.js', 'pi-native-adapter.js', 'golem-client.js',
    'golem-tool-contracts.js', 'golem-tool-runtime.js', 'session-role.js',
  ].map((name) => item(`runtime:${name}`, `lib/${name}`, path.join(repoRoot, 'lib', name)));
  const resources = [];
  resources.push(item('instructions:AGENTS.md', 'instructions/AGENTS.md', path.join(substrateRoot, 'instructions', 'AGENTS.md')));
  for (const role of PI_ROLES) resources.push(item(`role:${role}`, `roles/${role}.md`, path.join(substrateRoot, 'roles', `${role}.md`)));
  for (const skill of PI_SKILLS) {
    const root = path.join(substrateRoot, 'skills', skill);
    for (const abs of files(root)) {
      const rel = path.relative(path.join(substrateRoot, 'skills'), abs);
      resources.push(item(`skill:${rel}`, path.join('skills', rel), abs));
    }
  }
  for (const name of ['tracker-context.sh', '_golem-home.sh']) {
    resources.push(item(`hook:${name}`, `hooks/${name}`, path.join(substrateRoot, 'hooks', name)));
  }
  return [item('extension', 'golem.ts', extension), ...runtime, ...resources, ...[
    ['capabilities', 'capabilities.json', capabilities], ['package', 'package.json', pkg], ['readme', 'README.md', readme],
  ].map(([key, outputRelPath, value]) => ({ key, outputRelPath, sourceSha256: sha256(JSON.stringify(value)), build: () => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` }))];
}
