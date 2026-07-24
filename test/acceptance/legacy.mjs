#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const evidenceDirectory = path.join(
	repositoryRoot,
	"docs",
	"verification",
	"gol-12",
);
const baseline = path.join(
	repositoryRoot,
	"test",
	"parity",
	"legacy-baseline.mjs",
);
const child = spawnSync(process.execPath, [baseline], {
	cwd: repositoryRoot,
	encoding: "utf8",
	env: process.env,
});
const stdout = child.stdout ?? "";
const stderr = child.stderr ?? "";
process.stdout.write(stdout);
process.stderr.write(stderr);
const passed = child.status === 0;
const scenarioCount = [...stdout.matchAll(/^PASS J\d-/gmu)].length;
const result = {
	schema_version: "golem.acceptance-legacy/v1",
	status: passed ? "PASS" : "FAIL",
	command: "node test/parity/legacy-baseline.mjs",
	exit_code: child.status ?? 1,
	scenario_count: scenarioCount,
	decisive_log: passed
		? `legacy parity baseline passed (${scenarioCount} real-boundary scenarios)`
		: "legacy parity baseline failed; see command output",
};
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.writeFileSync(
	path.join(evidenceDirectory, "legacy-results.json"),
	`${JSON.stringify(result, null, 2)}\n`,
);
process.exitCode = child.status ?? 1;
