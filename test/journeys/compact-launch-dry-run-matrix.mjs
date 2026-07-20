import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createTemporaryHome } from "@golem/testkit";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);

export async function exerciseCompactLaunchDryRunMatrix() {
	const home = createTemporaryHome("golem-gol67-cli-");
	const sentinel = path.join(home.root, "cli-sentinel.txt");
	fs.writeFileSync(sentinel, "cli-preserve-this-byte\n");
	const childScript = `
import fs from "node:fs";
import { launchPlanBridge, resolveLaunch, stableLaunchPlanJson } from "@golem/launcher";
const now = "2026-07-20T00:00:00.000Z";
const local = resolveLaunch({ harness: "claude", preset: "local", isTTY: false, now });
const direct = resolveLaunch({ harness: "codex", preset: "direct", isTTY: false, now });
if (!local.ok || !direct.ok) throw new Error("compact dry-run resolver rejected a launchable plan");
if (fs.readFileSync(process.env.GOLEM_SPLIT_SENTINEL, "utf8") !== "cli-preserve-this-byte\\n") throw new Error("temporary-home sentinel changed");
process.stdout.write(stableLaunchPlanJson({
  local: launchPlanBridge(local),
  direct: launchPlanBridge(direct),
  sentinel: "preserved",
}));
`;
	try {
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...home.env,
				PATH: "/private/tmp/golem-node-v24.18.0-arm64/bin:/usr/local/bin:/usr/bin:/bin",
				GOLEM_SPLIT_SENTINEL: sentinel,
			},
		});
		assert.equal(result.status, 0, `compact built resolver/CLI child failed: ${result.stderr}`);
		const output = JSON.parse(result.stdout);
		assert.deepEqual(output.local.launch, {
			remediation: "Keep the installed harness and adapter contribution available.",
			reason: "The selected harness, backend, and model have a launch contribution.",
			status: "launchable",
		});
		assert.equal(output.local.delivery.mode, "native_channel");
		assert.equal(output.local.delivery.qualification, "unknown");
		assert.equal(output.local.delivery.readiness, "not_ready");
		assert.equal(output.direct.launch.status, "launchable");
		assert.equal(output.direct.delivery.mode, "pull");
		assert.equal(output.direct.delivery.readiness, "not_ready");
		assert.equal(output.sentinel, "preserved");
		assert.equal(result.stdout.includes(home.token), false);
		assert.equal(result.stdout.includes("secret-value"), false);
		assert.equal(fs.readFileSync(sentinel, "utf8"), "cli-preserve-this-byte\n");
		return "temporary-home child dry-run: built launcher bridge emits independent launch/delivery JSON for Claude/Ollama and direct Codex with no credential/path leakage";
	} finally {
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "temporary GOLEM_HOME must be removed");
	}
}
