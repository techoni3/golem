// Pi remains product Tier B until the tools/resources/dashboard/release waves
// land, but this adapter ships its native typed-worker delivery primitive.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256File } from '../engine.js';

function item(key, outputRelPath, source) {
  return { key, outputRelPath, sourceSha256: sha256File(source), build: () => fs.readFileSync(source) };
}

export function buildPlan({ repoRoot, packageVersion }) {
  const extension = path.join(repoRoot, 'shims', 'pi', 'golem.ts');
  const capabilities = {
    schema: 1, harness: 'pi', tier: 'B', lifecycle: true, mcp: false, subagents: false,
    delivery: ['typed-worker', 'next_turn_migration'], push_delivery: true, node: '>=22.19',
    limitation: 'Native delivery is available, but first-class worker status still requires Golem tools/resources, managed launch, dashboard cutover, and release proof.',
  };
  const pkg = { name: '@laveesingh/golem-pi-extension', version: packageVersion, private: true, type: 'module', pi: { extensions: ['./golem.ts'] } };
  const readme = '# Golem for Pi (Tier B)\n\nRequires Pi 0.80.10 and Node.js >=22.19. Load without changing a profile:\n\n```sh\nGOLEM_DIR="${GOLEM_HOME:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/golem}}"\n[ -n "$GOLEM_DIR" ] || { [ -d "$HOME/.golem" ] && GOLEM_DIR="$HOME/.golem" || GOLEM_DIR="$HOME/.config/golem"; }\npi -e "$GOLEM_DIR/renders/pi/golem.ts"\n```\n\nThis follows Golem’s canonical GOLEM_HOME/XDG/migrated/legacy resolution when `GOLEM_HOME` is unset. The extension registers an authenticated typed-worker endpoint, records canonical lifecycle facts and central journal events, and keeps the former next-turn inbox reader only for already-published migration records. Product Tier-A promotion remains deferred until the tools, launcher, dashboard, and release-proof slices land.\n';
  const runtime = [
    'golem-home.js', 'project-id.js', 'session-facts.js', 'typed-worker-endpoint.js',
    'typed-delivery-tombstones.js', 'pi-native-adapter.js',
  ].map((name) => item(`runtime:${name}`, `lib/${name}`, path.join(repoRoot, 'lib', name)));
  return [item('extension', 'golem.ts', extension), ...runtime, ...[
    ['capabilities', 'capabilities.json', capabilities], ['package', 'package.json', pkg], ['readme', 'README.md', readme],
  ].map(([key, outputRelPath, value]) => ({ key, outputRelPath, sourceSha256: sha256(JSON.stringify(value)), build: () => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` }))];
}
