import { spawnSync } from "node:child_process";

import { qualifyClaude } from "../dist/index.js";

const safeEnv = Object.fromEntries(
	["PATH", "LANG", "LC_ALL", "TZ"]
		.filter((key) => typeof process.env[key] === "string")
		.map((key) => [key, process.env[key]]),
);

const launch = async () => {
	const probe = spawnSync("claude", ["--version"], {
		encoding: "utf8",
		env: safeEnv,
		timeout: 2000,
		maxBuffer: 16 * 1024,
	});
	if (probe.error || probe.status !== 0) {
		return {
			ok: false,
			reasonCode: "claude.launch.unavailable",
		};
	}
	const version = String(probe.stdout ?? "")
		.split(/\r?\n/u)[0]
		?.trim()
		.slice(0, 64);
	return {
		ok: true,
		...(version ? { claudeVersion: version } : {}),
	};
};

const result = await qualifyClaude({
	launch,
	consume: async () => ({ consumed: false }),
});

process.stdout.write(
	`${JSON.stringify({
		schema_version: "golem.claude-qualification/v1",
		capability: result.capability,
		launchable: result.launchable,
		readiness: result.readiness,
		reason_code: result.reasonCode,
		remediation: result.remediation,
		evidence: result.evidence,
	})}\n`,
);
