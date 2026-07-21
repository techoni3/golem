#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const entry = resolve(root, "dist/apps/cli/golem.js");
if (process.env.GOLEM_COMPAT_HOP) {
	process.stderr.write(
		"golemc.compat.recursion: invoke `golem claude` directly\n",
	);
	process.exitCode = 2;
} else if (!existsSync(entry)) {
	process.stderr.write(
		"golemc.compat.build_unavailable: run `npm run build -w apps/cli`\n",
	);
	process.exitCode = 1;
} else {
	process.stderr.write(
		"golemc is deprecated; use `golem claude` (the alias delegates once)\n",
	);
	const typed = await import(pathToFileURL(entry).href);
	process.exitCode = await typed.runCli(["claude", ...process.argv.slice(2)]);
}
