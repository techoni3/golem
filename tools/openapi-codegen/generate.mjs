import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./check.mjs";

const toolDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const input = path.join(
	repositoryRoot,
	"apps/control-plane/generated/openapi.json",
);
const output = path.join(
	repositoryRoot,
	"packages/api-client/src/generated/openapi.ts",
);
const cli = path.join(
	toolDirectory,
	"node_modules/openapi-typescript/bin/cli.js",
);
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(input))
	throw new Error(
		`OpenAPI artifact is missing: ${path.relative(repositoryRoot, input)}; run the control-plane build first`,
	);

const temporaryDirectory = fs.mkdtempSync(
	path.join(os.tmpdir(), "golem-openapi-"),
);
const candidate = checkOnly
	? path.join(temporaryDirectory, "openapi.ts")
	: output;
try {
	if (!checkOnly) fs.mkdirSync(path.dirname(output), { recursive: true });
	const result = spawnSync(
		process.execPath,
		[cli, input, "--output", candidate, "--immutable"],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
		},
	);
	if (result.status !== 0)
		throw new Error(
			`openapi-typescript failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
		);
	if (checkOnly) {
		if (
			!fs.existsSync(output) ||
			fs.readFileSync(output, "utf8") !== fs.readFileSync(candidate, "utf8")
		)
			throw new Error(
				"generated API client is stale; run npm run api:generate",
			);
		process.stdout.write(
			"OpenAPI generated client is deterministic and current\n",
		);
	} else {
		process.stdout.write(
			`generated ${path.relative(repositoryRoot, output)}\n`,
		);
	}
} finally {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
