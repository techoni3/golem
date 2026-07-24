// Pi Tier-B adapter. Pi extensions can inject with sendUserMessage, but no
// documented external endpoint can address an idle interactive process.
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
    delivery: ['pull', 'next_turn'], push_delivery: false, node: '>=22.19',
    limitation: 'Pi has in-process sendUserMessage APIs, but no documented external endpoint for addressing a live idle TUI. Durable inbox items are claimed on the next input event.',
  };
  const pkg = { name: '@laveesingh/golem-pi-extension', version: packageVersion, private: true, type: 'module', pi: { extensions: ['./golem.ts'] } };
  const readme = '# Golem for Pi (Tier B)\n\nRequires Pi and Node.js >=22.19. Load without changing a profile:\n\n```sh\nGOLEM_DIR="${GOLEM_HOME:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/golem}}"\n[ -n "$GOLEM_DIR" ] || { [ -d "$HOME/.golem" ] && GOLEM_DIR="$HOME/.golem" || GOLEM_DIR="$HOME/.config/golem"; }\npi -e "$GOLEM_DIR/renders/pi/golem.ts"\n```\n\nThis follows Golem’s canonical GOLEM_HOME/XDG/migrated/legacy resolution when `GOLEM_HOME` is unset. The extension records canonical session facts and pulls durable addressed inbox entries on the next user input. It does not claim idle push delivery.\n';
  const runtime = ['golem-home.js', 'session-facts.js'].map((name) => item(`runtime:${name}`, `lib/${name}`, path.join(repoRoot, 'lib', name)));
  return [item('extension', 'golem.ts', extension), ...runtime, ...[
    ['capabilities', 'capabilities.json', capabilities], ['package', 'package.json', pkg], ['readme', 'README.md', readme],
  ].map(([key, outputRelPath, value]) => ({ key, outputRelPath, sourceSha256: sha256(JSON.stringify(value)), build: () => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` }))];
}
