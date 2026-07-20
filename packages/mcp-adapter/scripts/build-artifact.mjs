import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const outfile = join(packageRoot, "dist", "golem-mcp.mjs");

await build({
	entryPoints: [join(packageRoot, "dist", "bootstrap.js")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node24",
	external: ["node:*"],
	legalComments: "none",
});

// esbuild preserves whitespace-only lines from bundled template strings. They
// have no runtime meaning, but stripping them here keeps the checked-in render
// artifact deterministic and compatible with `git diff --check`.
const artifact = await readFile(outfile, "utf8");
await writeFile(outfile, artifact.replace(/[ \t]+$/gm, ""));
