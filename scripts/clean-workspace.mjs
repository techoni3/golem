import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageDirectories = [
	"apps/cli",
	"apps/control-plane",
	"apps/dashboard",
	"packages/adapter-sdk",
	"packages/adapters/claude",
	"packages/adapters/codex",
	"packages/adapters/opencode",
	"packages/adapters/pi",
	"packages/api-client",
	"packages/compat",
	"packages/compiler",
	"packages/contracts",
	"packages/domain",
	"packages/launcher",
	"packages/mcp-adapter",
	"packages/persistence",
	"packages/runtime",
	"packages/testkit",
	"packages/tracker",
	"packages/ui",
];

for (const directory of packageDirectories) {
	await rm(join(root, directory, "dist"), { force: true, recursive: true });
	await rm(join(root, directory, "tsconfig.tsbuildinfo"), { force: true });
}
process.stdout.write(
	`cleaned ${packageDirectories.length} bounded workspace outputs\n`,
);
