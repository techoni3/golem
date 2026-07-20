import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	builtInCapabilities,
	doctorFacts,
	launchPlanBridge,
	listLauncher,
	parseJsoncConfig,
	resolveLaunch,
	stableLaunchPlanJson,
} from "@golem/launcher";
import { createTemporaryHome } from "@golem/testkit";

const now = "2026-07-20T00:00:00.000Z";

function assertPlan(result, label) {
	assert.equal(result.ok, true, `${label}: ${result.ok ? "" : result.error.code}`);
	return result;
}

function preset(name, harness, backend, modelSelector, deliveryMode) {
	return {
		name,
		harness,
		backend,
		model_selector: modelSelector,
		delivery_mode: deliveryMode,
		native_args: [],
		env_key_refs: backend === "openai" ? ["OPENAI_API_KEY"] : [],
	};
}

export async function exerciseLauncherLaunchabilityDeliverySplit() {
	const home = createTemporaryHome("golem-gol67-split-");
	const sentinel = path.join(home.root, "sentinel.txt");
	fs.writeFileSync(sentinel, "preserve-this-byte\n");
	try {
		const claudeLocal = assertPlan(
			resolveLaunch({ harness: "claude", preset: "local", isTTY: false, now }),
			"Claude/Ollama local",
		);
		assert.equal(claudeLocal.launch.status, "launchable");
		assert.equal(claudeLocal.delivery.mode, "native_channel");
		assert.equal(claudeLocal.delivery.qualification, "unknown");
		assert.equal(claudeLocal.delivery.readiness, "not_ready");
		assert.equal(claudeLocal.capabilityFacts.deliveryFlow, "pull");
		assert.equal(claudeLocal.warnings.length, 1);
		assert.match(claudeLocal.warnings[0].code, /delivery\.not_ready/);
		assert.equal(Object.isFrozen(claudeLocal.launch), true);
		assert.equal(Object.isFrozen(claudeLocal.delivery), true);
		const localBridge = launchPlanBridge(claudeLocal);
		assert.equal(Object.isFrozen(localBridge), true);
		assert.deepEqual(localBridge, {
			launch: claudeLocal.launch,
			delivery: claudeLocal.delivery,
		});

		// Adapter-owned diagnostics are untrusted: delivery text is redacted at
		// the immutable bridge while launch text fails closed before spawn.
		const localSnapshot = builtInCapabilities.find(
			(snapshot) => snapshot.capability.capability_id === "claude.ollama-local.direct",
		);
		assert(localSnapshot, "Claude/Ollama local adapter fixture is present");
		const hostileDelivery = {
			...localSnapshot,
			capability: { ...localSnapshot.capability, capability_id: "fixture-hostile-delivery" },
			launchContribution: {
				status: "launchable",
				reason: "fixture launch contribution is available",
				remediation: "Keep the installed adapter contribution available.",
			},
			deliveryReason:
				"adapter token=marker-token credential=marker-credential provider OPENAI_API_KEY=marker-openai-api-key",
			deliveryRemediation:
				"adapter password=marker-password api_key=marker-api-key Clear accessToken=marker-access-token",
		};
		const hostileDeliveryPlan = assertPlan(
			resolveLaunch({
				harness: "claude",
				preset: "local",
				isTTY: false,
				now,
				capabilities: [hostileDelivery],
			}),
			"hostile delivery diagnostics",
		);
		const hostileBridge = launchPlanBridge(hostileDeliveryPlan);
		assert.equal(hostileBridge.delivery.readiness, "not_ready");
		assert.equal(Object.isFrozen(hostileBridge), true);
		assert.equal(Object.isFrozen(hostileBridge.launch), true);
		assert.equal(Object.isFrozen(hostileBridge.delivery), true);
		const hostilePublicJson = stableLaunchPlanJson({
			adapterFacts: hostileDelivery,
			bridge: hostileBridge,
			plan: hostileDeliveryPlan,
		});
		for (const pattern of [
			/token\s*=/iu,
			/credential\s*=/iu,
			/password\s*=/iu,
			/api_key\s*=/iu,
			/owner_token\s*=/iu,
			/OPENAI_API_KEY\s*=/u,
			/accessToken\s*=/u,
		])
			assert.equal(pattern.test(hostilePublicJson), false, `adapter diagnostic leaked ${pattern}`);
		for (const marker of [
			"marker-token",
			"marker-credential",
			"marker-password",
			"marker-api-key",
			"marker-openai-api-key",
			"marker-access-token",
		])
			assert.equal(hostilePublicJson.includes(marker), false, `adapter marker leaked ${marker}`);

		const hostileLaunch = {
			...hostileDelivery,
			capability: { ...hostileDelivery.capability, capability_id: "fixture-hostile-launch" },
			launchContribution: {
				status: "launchable",
				reason: "upstream owner_token=marker-owner-token",
				remediation: "adapter api_key=marker-api-key",
			},
		};
		const hostileLaunchFailure = resolveLaunch({
			harness: "claude",
			preset: "local",
			isTTY: false,
			now,
			capabilities: [hostileLaunch],
		});
		assert.equal(hostileLaunchFailure.ok, false, "unsafe launch diagnostics fail closed");
		if (!hostileLaunchFailure.ok) {
			assert.equal(hostileLaunchFailure.error.code, "launcher.launch.unavailable");
			const failureJson = stableLaunchPlanJson(hostileLaunchFailure);
			for (const pattern of [
				/token\s*=/iu,
				/credential\s*=/iu,
				/password\s*=/iu,
				/api_key\s*=/iu,
				/owner_token\s*=/iu,
				/OPENAI_API_KEY\s*=/u,
				/accessToken\s*=/u,
			])
				assert.equal(pattern.test(failureJson), false, `launch failure leaked ${pattern}`);
			for (const marker of ["marker-owner-token", "marker-api-key"])
				assert.equal(failureJson.includes(marker), false, `launch marker leaked ${marker}`);
		}

		const missingCredential = resolveLaunch({
			harness: "codex",
			isTTY: false,
			now,
			availableEnvironmentKeys: [],
		});
		assert.equal(missingCredential.ok, false);
		assert.equal(missingCredential.error.code, "launcher.environment.secret_missing");

		const unavailableSnapshot = {
			...builtInCapabilities.find(
				(snapshot) => snapshot.capability.capability_id === "codex.openai.managed",
			),
			launchContribution: {
				status: "unavailable",
				reason: "fixture binary is absent",
				remediation: "Install the managed Codex contribution.",
			},
		};
		const unavailable = resolveLaunch({
			harness: "codex",
			isTTY: false,
			now,
			capabilities: [unavailableSnapshot],
		});
		assert.equal(unavailable.ok, false);
		assert.equal(unavailable.error.code, "launcher.launch.unavailable");

		const unsupportedManaged = parseJsoncConfig(
			JSON.stringify({
				user_owned: { keep: true },
				schema_version: "golem.launcher-config/v1",
				launch: {
					harness_defaults: { codex: "local" },
					presets: [preset("local", "codex", "ollama_local", "*", "managed_app_server")],
				},
			}),
			"user",
		);
		const unsupported = resolveLaunch({
			harness: "codex",
			user: unsupportedManaged,
			isTTY: false,
			now,
		});
		assert.equal(unsupported.ok, false);
		assert.equal(unsupported.error.code, "launcher.launch.unavailable");

		const unknownPreset = resolveLaunch({
			harness: "claude",
			preset: "missing",
			isTTY: false,
			now,
		});
		assert.equal(unknownPreset.ok, false);
		assert.equal(unknownPreset.error.code, "launcher.preset.unknown");

		for (const [harness, presetName] of [
			["opencode", "default"],
			["opencode", "local"],
			["opencode", "cloud"],
		]) {
			const plan = assertPlan(
				resolveLaunch({ harness, preset: presetName, isTTY: false, now }),
				`${harness}/${presetName}`,
			);
			assert.equal(plan.launch.status, "launchable");
			assert.equal(plan.delivery.readiness, "not_ready");
			assert.notEqual(plan.capabilityFacts.deliveryFlow, "push");
		}
		const directCodex = assertPlan(
			resolveLaunch({ harness: "codex", preset: "direct", isTTY: false, now }),
			"direct Codex",
		);
		assert.equal(directCodex.launch.status, "launchable");
		assert.equal(directCodex.delivery.mode, "pull");
		assert.equal(directCodex.delivery.readiness, "not_ready");
		assert.equal(directCodex.capabilityFacts.deliveryFlow, "pull");

		const user = parseJsoncConfig(
			JSON.stringify({
				user_token: "secret-value",
				schema_version: "golem.launcher-config/v1",
				launch: {
					harness_defaults: { codex: "review" },
					presets: [preset("review", "codex", "openai", "gpt-4.1", "managed_app_server")],
				},
			}),
			"user",
		);
		const configured = assertPlan(
			resolveLaunch({ harness: "codex", user, isTTY: false, now }),
			"configured Codex",
		);
		const stable = stableLaunchPlanJson(configured);
		assert.equal(stable.includes("secret-value"), false);
		assert.equal(stable.includes('"deliveryFlow":"push"'), true);

		const listed = listLauncher({ now, capabilities: builtInCapabilities });
		const doctored = doctorFacts(builtInCapabilities, now);
		const listedById = new Map(listed.capabilities.map((entry) => [entry.id, entry]));
		const doctorById = new Map(doctored.map((entry) => [entry.id, entry]));
		for (const snapshot of builtInCapabilities) {
			const id = snapshot.capability.capability_id;
			const listEntry = listedById.get(id);
			const doctorEntry = doctorById.get(id);
			assert(listEntry && doctorEntry, `${id} must be projected by list and doctor`);
			assert.deepEqual(listEntry.launch, doctorEntry.launch, `${id} launch projection`);
			assert.deepEqual(listEntry.delivery, doctorEntry.delivery, `${id} delivery projection`);
		}
		assert.equal(listedById.get("claude.anthropic.direct").launch.status, "unavailable");
		assert.equal(listedById.get("claude.ollama-local.direct").launch.status, "launchable");

		assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve-this-byte\n");
		return "temporary-home resolver matrix: launchable unknown-delivery Claude/Ollama, credential and launch preflight rejection, managed Codex boundary, OpenCode provider variants, canonical bridge, list/doctor parity, and secret-safe stable output verified";
	} finally {
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "temporary GOLEM_HOME must be removed");
	}
}
