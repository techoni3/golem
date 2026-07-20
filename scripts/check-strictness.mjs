import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
const fixture = join(root, "test", "fixtures", "workspace-strict", "unsafe.ts");

if (!existsSync(compiler))
	throw new Error("root TypeScript 7 compiler is not installed");
const result = spawnSync(
	process.execPath,
	[
		compiler,
		"--ignoreConfig",
		"--noEmit",
		"--strict",
		"--noUncheckedIndexedAccess",
		"--exactOptionalPropertyTypes",
		fixture,
	],
	{
		encoding: "utf8",
		cwd: root,
	},
);
if (result.error) throw result.error;
if (result.status === 0)
	throw new Error("strict TypeScript fixture unexpectedly passed");
const output = `${result.stdout}\n${result.stderr}`;
if (!/not assignable/iu.test(output))
	throw new Error(`strict fixture failed for an unexpected reason: ${output}`);
process.stdout.write("strict TypeScript fixture rejected unsafe assignment\n");
