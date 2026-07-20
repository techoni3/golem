import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
	entryPoints: [join(packageRoot, "dist", "bootstrap.js")],
	outfile: join(packageRoot, "dist", "golem-mcp.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node24",
	external: ["node:*"],
	legalComments: "none",
});
