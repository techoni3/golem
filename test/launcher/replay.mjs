import assert from "node:assert/strict";

import {
	doctorFacts,
	listLauncher,
	loadJsoncConfig,
	mergeOpenCodeManagedRegion,
	parseJsoncConfig,
	planConfigWrite,
	resolveLaunch,
	stableLaunchPlanJson,
	writeJsoncConfig,
} from "@golem/launcher";

const now = "2026-07-20T00:00:00.000Z";
const schemaVersion = "golem.launcher-config/v1";

function preset(name, harness, backend, modelSelector, deliveryMode, extra = {}) {
	return {
		name,
		harness,
		backend,
		model_selector: modelSelector,
		delivery_mode: deliveryMode,
		native_args: [],
		env_key_refs: backend === "openai" ? ["OPENAI_API_KEY"] : [],
		...extra,
	};
}

function configText({
	defaults = {},
	presets = [],
	extra = '"user_owned": { "keep": true, "user_token": "secret-value" }',
}) {
	return `// user-owned comment must survive managed writes\n{\n  ${extra},\n  "schema_version": "${schemaVersion}",\n  "launch": {\n    "harness_defaults": ${JSON.stringify(defaults)},\n    "presets": ${JSON.stringify(presets)}\n  }\n}\n`;
}

function snapshot({
	id,
	harness = "codex",
	mode = "managed",
	backend = "openai",
	modelPattern = "gpt-*",
	deliveryMode = "managed_app_server",
	readiness = "ready",
	flow = deliveryMode === "pull" ? "pull" : deliveryMode === "next_turn" ? "next_turn" : "push",
	qualification = "supported",
	source = "real_journey",
	policy = "observed",
	observedAt = now,
	controlFeatures = [],
}) {
	return {
		capability: {
			capability_id: id,
			harness,
			adapter_version: "fixture-v1",
			integration_layers: deliveryMode === "managed_app_server" ? ["app_server"] : ["hooks"],
			qualification,
			delivery_mode: deliveryMode,
			readiness,
			evidence_version: "fixture-v1",
		},
		mode,
		backend,
		modelPattern,
		deliveryFlow: flow,
		controlFeatures,
		executable: harness,
		evidenceSource: source,
		evidencePolicy: policy,
		...(observedAt === undefined ? {} : { evidenceObservedAt: observedAt }),
	};
}

function assertPlan(result, expected) {
	assert.equal(result.ok, true, result.ok ? "" : result.error.code);
	if (!result.ok) return result;
	for (const [key, value] of Object.entries(expected))
		assert.equal(result.selection[key], value);
	return result;
}

function atomicPort(
	initial,
	{
		interruptCommit = false,
		partialTemporaryFailure = false,
		rollbackFailure = false,
	} = {},
) {
	const files = new Map([["/virtual/config.jsonc", initial]]);
	const operations = [];
	return {
		files,
		operations,
		port: {
			readText: async (path) => files.get(path),
			writeBackup: async (path, text) => {
				operations.push("backup");
				files.set(path, text);
			},
			writeTemporary: async (path, text) => {
				operations.push("temporary");
				files.set(path, text);
				if (partialTemporaryFailure)
					throw new Error("temporary-sentinel-secret-value");
			},
			commitTemporary: async (temporaryPath, targetPath) => {
				operations.push("commit");
				if (interruptCommit) {
					files.set(targetPath, "{ partial");
					throw new Error("simulated interrupted commit");
				}
				files.set(targetPath, files.get(temporaryPath));
			},
			rollback: async (targetPath, backupPath) => {
				operations.push("rollback");
				if (rollbackFailure)
					throw new Error("rollback-sentinel-secret-value");
				files.set(targetPath, files.get(backupPath));
			},
			removeTemporary: async (path) => {
				operations.push("remove-temporary");
				files.delete(path);
			},
		},
	};
}

function assertFailure(input, code, label) {
	const result = resolveLaunch(input);
	assert.equal(result.ok, false, label);
	if (!result.ok) assert.equal(result.error.code, code, label);
	return result;
}

export async function runLauncherResolutionReplay() {
	const userPresets = [
		preset("review", "codex", "openai", "gpt-4.1", "managed_app_server"),
		preset("glm", "codex", "openai", "gpt-5", "managed_app_server"),
	];
	const user = parseJsoncConfig(
		configText({ defaults: { codex: "review" }, presets: userPresets }),
		"user",
	);
	const userPermutation = parseJsoncConfig(
		configText({ defaults: { codex: "review" }, presets: [...userPresets].reverse() }),
		"user",
	);
	const project = parseJsoncConfig(
		configText({
			defaults: { codex: "project" },
			presets: [
				preset("project", "codex", "openai", "gpt-5", "managed_app_server"),
				preset("project-local", "opencode", "ollama_local", "*", "prompt_bridge"),
			],
			extra: '"project_note": "preserved outside launch"',
		}),
		"project",
	);
	const projectPermutation = parseJsoncConfig(
		configText({
			defaults: { codex: "project" },
			presets: [
				preset("project-local", "opencode", "ollama_local", "*", "prompt_bridge"),
				preset("project", "codex", "openai", "gpt-5", "managed_app_server"),
			],
			extra: '"project_note": "preserved outside launch"',
		}),
		"project",
	);
	const localWithDependencies = parseJsoncConfig(
		configText({
			presets: [
				preset("local", "opencode", "ollama_local", "*", "prompt_bridge", {
					native_args: ["--ollama-local"],
					env_key_refs: ["OLLAMA_API_KEY"],
					binary_override: "opencode-local",
				}),
			],
		}),
		"user",
	);

	const cases = [
		{
			label: "built-in default",
			input: { harness: "codex", isTTY: false, now },
			expected: { harness: "codex", mode: "managed", backend: "openai", modelSelector: "gpt-*" },
			source: "built_in",
		},
		{
			label: "user default",
			input: { harness: "codex", user, isTTY: false, now },
			expected: { harness: "codex", mode: "managed", backend: "openai", modelSelector: "gpt-4.1" },
			source: "user_default",
		},
		{
			label: "project beats user",
			input: { harness: "codex", user, project, isTTY: false, now },
			expected: { harness: "codex", mode: "managed", backend: "openai", modelSelector: "gpt-5" },
			source: "project_default",
		},
		{
			label: "scoped preset",
			input: { harness: "opencode", preset: "local", isTTY: false, now },
			expected: { harness: "opencode", mode: "direct", backend: "ollama_local", modelSelector: "*" },
			source: "invoked_scoped",
		},
		{
			label: "global preset beats project/user defaults",
			input: { globalPreset: "glm", user, project, isTTY: false, now },
			expected: { harness: "codex", mode: "managed", backend: "openai", modelSelector: "gpt-5" },
			source: "invoked_global",
		},
		{
			label: "explicit model beats invoked global preset",
			input: {
				globalPreset: "glm",
				user,
				project,
				explicit: { modelSelector: "gpt-*" },
				isTTY: false,
				now,
			},
			expected: { harness: "codex", mode: "managed", backend: "openai", modelSelector: "gpt-*" },
			source: "invoked_global",
		},
		{
			label: "explicit model refines invoked scoped preset",
			input: {
				harness: "opencode",
				preset: "local",
				explicit: { modelSelector: "llama3*" },
				isTTY: false,
				now,
			},
			expected: { harness: "opencode", mode: "direct", backend: "ollama_local", modelSelector: "llama3*" },
			source: "invoked_scoped",
		},
		{
			label: "explicit beats project",
			input: {
				harness: "codex",
				user,
				project,
				explicit: { modelSelector: "gpt-*" },
				passthrough: ["--verbose"],
				isTTY: false,
				now,
			},
			expected: { harness: "codex", mode: "managed", backend: "openai", modelSelector: "gpt-*" },
			source: "project_default",
		},
	];
	for (const entry of cases) {
		const plan = assertPlan(resolveLaunch(entry.input), entry.expected);
		assert.equal(plan.preset.source, entry.source, entry.label);
	}
	const crossHarnessOverride = assertFailure(
		{
			harness: "opencode",
			preset: "local",
			user: localWithDependencies,
			explicit: {
				harness: "codex",
				mode: "managed",
				backend: "openai",
				modelSelector: "gpt-*",
				deliveryMode: "managed_app_server",
			},
			isTTY: false,
			now,
		},
		"launcher.override.preset_incompatible",
		"cross-harness override cannot inherit local preset dependencies",
	);
	assert.equal(
		stableLaunchPlanJson(crossHarnessOverride).includes("opencode-local"),
		false,
		"rejected cross-harness override exposes no preset executable",
	);
	assert.equal(
		stableLaunchPlanJson(crossHarnessOverride).includes("OLLAMA_API_KEY"),
		false,
		"rejected cross-harness override exposes no preset environment key",
	);
	assert.equal(
		stableLaunchPlanJson(crossHarnessOverride).includes("--ollama-local"),
		false,
		"rejected cross-harness override exposes no preset argument",
	);
	assertFailure(
		{
			harness: "opencode",
			preset: "local",
			user: localWithDependencies,
			explicit: { backend: "openai" },
			isTTY: false,
			now,
		},
		"launcher.override.preset_incompatible",
		"backend-only override cannot inherit local preset dependencies",
	);
	const compatibleModelOverride = assertPlan(
		resolveLaunch({
			harness: "opencode",
			preset: "local",
			user: localWithDependencies,
			explicit: { modelSelector: "llama3*" },
			isTTY: false,
			now,
		}),
		{ harness: "opencode", mode: "direct", backend: "ollama_local", modelSelector: "llama3*" },
	);
	assert.deepEqual(
		[
			compatibleModelOverride.selection.executable,
			compatibleModelOverride.environmentKeyRefs,
			compatibleModelOverride.effectiveArgvIntent,
		],
		["opencode-local", ["OLLAMA_API_KEY"], ["opencode-local", "--ollama-local"]],
		"model-only overrides retain one coherent local preset dependency set",
	);

	const permutationLeft = resolveLaunch({
		harness: "codex",
		user,
		project,
		isTTY: false,
		now,
	});
	const permutationRight = resolveLaunch({
		harness: "codex",
		user: userPermutation,
		project: projectPermutation,
		isTTY: false,
		now,
	});
	assert.equal(
		stableLaunchPlanJson(permutationLeft),
		stableLaunchPlanJson(permutationRight),
		"preset declaration permutations converge byte-for-byte",
	);
	const deterministic = assertPlan(resolveLaunch(cases[7].input), cases[7].expected);
	assert.equal(deterministic.effectiveArgvIntent.includes("--verbose"), true);
	assert.equal(stableLaunchPlanJson(deterministic).includes("OPENAI_API_KEY"), true);
	assert.equal(stableLaunchPlanJson(deterministic).includes("secret-value"), false);
	assert.equal(deterministic.capabilityFacts.deliveryFlow, "push");
	assert.equal(deterministic.capabilityFacts.integrationLayers.includes("app_server"), true);
	assert.equal(deterministic.capabilityFacts.controlFeatures.includes("resume"), true);

	assertFailure({ isTTY: false, now }, "launcher.input.non_tty", "non-TTY needs selection");
	assertFailure({ harness: "codex", preset: "missing", isTTY: false, now }, "launcher.preset.unknown", "unknown preset");
	assertFailure({ harness: "opencode", globalPreset: "glm", user, isTTY: false, now }, "launcher.input.conflict", "global conflict");
	assertFailure({ harness: "unknown", isTTY: false, now }, "launcher.harness.unknown", "unknown harness");
	assertFailure({ harness: "codex", explicit: { backend: "not-a-backend" }, isTTY: false, now }, "launcher.selection.invalid", "unknown backend");
	for (const [label, modelSelector] of [
		["blank model", ""],
		["whitespace model", "   "],
		["secret-bearing model", "api_key=sentinel-secret-value"],
	]) {
		const modelFailure = assertFailure(
			{
				harness: "opencode",
				explicit: { modelSelector },
				isTTY: false,
				now,
			},
			"launcher.model.invalid",
			label,
		);
		assert.equal(modelFailure.error.remediation.length, 1, `${label} has one remedy`);
		assert.equal(
			stableLaunchPlanJson(modelFailure).includes("sentinel-secret-value"),
			false,
			`${label} is redacted from public failure serialization`,
		);
	}
	const passthroughFailure = resolveLaunch({
		harness: "codex",
		passthrough: ["--token=secret-value"],
		isTTY: false,
		now,
	});
	assert.equal(passthroughFailure.ok, false, "passthrough redaction");
	if (!passthroughFailure.ok)
		assert.equal(passthroughFailure.error.code, "launcher.argv.secret_or_unsafe");
	assertFailure({ harness: "claude", isTTY: false, now }, "launcher.capability.unqualified", "unqualified builtin");

	const duplicateNames = parseJsoncConfig(
		configText({
			presets: [
				preset("shared", "codex", "openai", "gpt-*", "managed_app_server"),
				preset("shared", "opencode", "openai", "gpt-*", "prompt_bridge"),
			],
		}),
		"user",
	);
	assertFailure({ globalPreset: "shared", user: duplicateNames, isTTY: false, now }, "launcher.preset.ambiguous", "duplicate global name");
	const duplicateScoped = parseJsoncConfig(
		configText({
			presets: [
				preset("same", "codex", "openai", "gpt-*", "managed_app_server"),
				preset("same", "codex", "openai", "gpt-5", "managed_app_server"),
			],
		}),
		"user",
	);
	assertFailure({ harness: "codex", user: duplicateScoped, isTTY: false, now }, "launcher.preset.ambiguous", "same-scope duplicate is stable review");
	assert.equal(listLauncher({ user: duplicateScoped, now }).issues[0].code, "launcher.preset.ambiguous");

	const stale = snapshot({ id: "stale", observedAt: "2020-01-01T00:00:00.000Z" });
	assertFailure({ harness: "codex", isTTY: false, now, capabilities: [stale] }, "launcher.capability.stale", "observed evidence expires");
	const invalidTime = snapshot({ id: "invalid-time", observedAt: "not-a-time" });
	assertFailure({ harness: "codex", isTTY: false, now, capabilities: [invalidTime] }, "launcher.capability.invalid_evidence", "invalid evidence time fails closed");
	const registration = snapshot({ id: "registered", harness: "claude", mode: "direct", backend: "anthropic", modelPattern: "claude-*", deliveryMode: "native_channel", source: "registration", qualification: "experimental" });
	assertFailure({ harness: "claude", isTTY: false, now, capabilities: [registration] }, "launcher.capability.registration_only", "registration never authorizes any qualification");
	const statusFacts = [
		snapshot({ id: "managed-push", controlFeatures: ["resume", "interrupt"] }),
		snapshot({ id: "direct-pull", mode: "direct", deliveryMode: "pull", readiness: "pull_only", flow: "pull" }),
		snapshot({ id: "direct-next-turn", mode: "direct", deliveryMode: "next_turn", readiness: "next_turn", flow: "next_turn" }),
		registration,
		invalidTime,
	];
	const listed = listLauncher({ capabilities: statusFacts, now });
	const doctor = doctorFacts(statusFacts, now);
	for (const surface of [passthroughFailure, listed, doctor])
		assert.equal(
			stableLaunchPlanJson(surface).includes("secret-value"),
			false,
			"failure/list/doctor facts never reveal a secret value",
		);
	assert.deepEqual(
		listed.capabilities.map((entry) => [entry.id, entry.qualification, entry.launchable]),
		doctor.map((entry) => [entry.id, entry.qualification, entry.launchable]),
		"resolve/list/doctor share one capability truth projection",
	);
	const byId = new Map(listed.capabilities.map((entry) => [entry.id, entry]));
	assert.deepEqual(
		[
			byId.get("managed-push")?.mode,
			byId.get("managed-push")?.deliveryFlow,
			byId.get("direct-pull")?.mode,
			byId.get("direct-pull")?.deliveryFlow,
			byId.get("direct-pull")?.readiness,
			byId.get("direct-next-turn")?.deliveryFlow,
			byId.get("direct-next-turn")?.readiness,
		],
		["managed", "push", "direct", "pull", "pull_only", "next_turn", "next_turn"],
		"direct/managed and push/pull/next-turn/readiness remain distinct facts",
	);
	assert.deepEqual(
		doctor.find((entry) => entry.id === "managed-push")?.integrationLayers,
		["app_server"],
		"doctor preserves app-server evidence",
	);
	assert.deepEqual(
		doctor.find((entry) => entry.id === "managed-push")?.controlFeatures,
		["interrupt", "resume"],
		"doctor preserves control evidence",
	);
	assert.equal(resolveLaunch({ harness: "codex", isTTY: false, now: "2035-01-01T00:00:00.000Z" }).ok, true, "version-qualified builtins do not self-expire after 30 days");

	const writePlan = planConfigWrite("/virtual/config.jsonc", user, user.config);
	assert.equal(JSON.stringify(writePlan).includes("secret-value"), false, "write plan is redacted");
	assert.equal(writePlan.preserveUnknownRegions, true);
	const success = atomicPort(user.text);
	const loaded = await loadJsoncConfig(success.port, "/virtual/config.jsonc", "user");
	await writeJsoncConfig(success.port, writePlan, loaded, loaded.config, "save_launcher_config");
	const saved = success.files.get("/virtual/config.jsonc");
	assert.match(saved, /user-owned comment/);
	assert.match(saved, /user_owned/);
	assert.deepEqual(success.operations, ["backup", "temporary", "commit"]);
	const interrupted = atomicPort(user.text, { interruptCommit: true });
	await assert.rejects(
		() => writeJsoncConfig(interrupted.port, writePlan, user, user.config, "save_launcher_config"),
		/launcher.config.atomic_write_failed/,
	);
	assert.equal(interrupted.files.get("/virtual/config.jsonc"), user.text, "interrupted commit rolls back original text");
	assert.equal(interrupted.files.has(writePlan.temporaryPath), false, "temporary write is cleaned up");
	assert.deepEqual(interrupted.operations, ["backup", "temporary", "commit", "rollback", "remove-temporary"]);

	const partialTemporary = atomicPort(user.text, { partialTemporaryFailure: true });
	await assert.rejects(
		() => writeJsoncConfig(partialTemporary.port, writePlan, user, user.config, "save_launcher_config"),
		(error) => {
			assert.equal(error?.name, "LauncherResolutionError");
			assert.equal(error?.message, "launcher.config.atomic_write_failed");
			assert.equal(String(error).includes("temporary-sentinel-secret-value"), false);
			return true;
		},
	);
	assert.equal(partialTemporary.files.get("/virtual/config.jsonc"), user.text, "partial temporary failure preserves the original target");
	assert.equal(partialTemporary.files.has(writePlan.temporaryPath), false, "partial temporary bytes are cleaned up even when the port throws");
	assert.deepEqual(partialTemporary.operations, ["backup", "temporary", "rollback", "remove-temporary"]);

	const rollbackFailure = atomicPort(user.text, {
		interruptCommit: true,
		rollbackFailure: true,
	});
	await assert.rejects(
		() => writeJsoncConfig(rollbackFailure.port, writePlan, user, user.config, "save_launcher_config"),
		(error) => {
			assert.equal(error?.name, "LauncherResolutionError");
			assert.equal(error?.message, "launcher.config.atomic_write_failed");
			assert.equal(error?.issue?.code, "launcher.config.atomic_write_failed");
			assert.equal(String(error).includes("rollback-sentinel-secret-value"), false);
			assert.equal(JSON.stringify(error?.issue).includes("rollback-sentinel-secret-value"), false);
			return true;
		},
	);
	assert.equal(rollbackFailure.files.has(writePlan.temporaryPath), false, "rollback failure still cleans the temporary target");
	assert.deepEqual(rollbackFailure.operations, ["backup", "temporary", "commit", "rollback", "remove-temporary"]);

	for (const invalidEvidence of [
		snapshot({ id: "invalid-policy", policy: "not-a-policy" }),
		snapshot({ id: "invalid-source", source: "not-a-source" }),
	]) {
		assertFailure(
			{ harness: "codex", isTTY: false, now, capabilities: [invalidEvidence] },
			"launcher.capability.invalid_evidence",
			`${invalidEvidence.capability.capability_id} fails closed at resolve`,
		);
		assert.deepEqual(
			listLauncher({ capabilities: [invalidEvidence], now }).capabilities.map((entry) => [entry.qualification, entry.launchable]),
			doctorFacts([invalidEvidence], now).map((entry) => [entry.qualification, entry.launchable]),
			`${invalidEvidence.capability.capability_id} projects one false capability truth`,
		);
		assert.deepEqual(
			doctorFacts([invalidEvidence], now).map((entry) => [entry.qualification, entry.launchable]),
			[["invalid_evidence", false]],
			`${invalidEvidence.capability.capability_id} is never authorized`,
		);
	}

	const openCode = mergeOpenCodeManagedRegion(
		'{\n  // keep this provider\n  "provider": { "openai": { "keep": true } },\n  "other": 1\n}\n',
		["provider", "ollama-local"],
		{ models: { local: {} } },
	);
	assert.match(openCode, /keep this provider/);
	assert.match(openCode, /"other": 1/);
	assert.throws(
		() => parseJsoncConfig(configText({ presets: [{ ...preset("bad", "codex", "openai", "gpt-*", "managed_app_server"), native_args: ["--token=secret-value"] }] }), "user"),
		/launcher.config.managed_invalid/,
	);
	assert.throws(
		() => parseJsoncConfig(configText({ presets: [{ ...preset("bad-executable", "codex", "openai", "gpt-*", "managed_app_server"), binary_override: "/usr/bin/codex;rm" }] }), "user"),
		/launcher.executable.unsafe/,
	);
	assert.throws(
		() => parseJsoncConfig(configText({ presets: [{ ...preset("project-binary", "codex", "openai", "gpt-*", "managed_app_server"), binary_override: "/tmp/not-allowed" }] }), "project"),
		/launcher.project.binary_override_forbidden/,
	);
	assert.throws(
		() => parseJsoncConfig('{ "schema_version": "golem.launcher-config/v1", "launch": { "harness_defaults": {}, "presets": [], "shell": "sh" } }', "project"),
		/launcher.config.managed_invalid/,
	);

	return "precedence permutations, model-boundary redaction, partial JSONC cleanup, stable rollback errors, closed evidence truth, and read-only launcher APIs verified";
}
