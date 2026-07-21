import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const directJourney = path.join(repositoryRoot, "test/codex-direct-adapter.test.mjs");

/**
 * J5 retention guard: compact launcher changes must not replace or weaken the
 * installed native-Codex hook path. The child renders a real disposable Codex
 * integration and proves lifecycle, aliases, resume, redaction, and pull-only
 * capability through the real generated hook rather than a launcher mock.
 */
export function exerciseDirectLaunchRetainsIntegration() {
	const result = spawnSync(
		process.execPath,
		["--test", "--test-concurrency=1", directJourney],
		{ cwd: repositoryRoot, encoding: "utf8", env: process.env },
	);
	assert.equal(
		result.status,
		0,
		`direct native-Codex retention journey failed:\n${result.stdout}\n${result.stderr}`,
	);
	assert.match(result.stdout, /pass 1/u);
	return "J5 real rendered native-Codex integration retained canonical project/session lifecycle, pull-only delivery truth, resume lineage, concurrent revision safety, and token-redacted durable signals while compact launcher UX changed";
}
