import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	CompatibilityIngressV1Schema,
	ContractFixtures,
	ContractSchemaRegistry,
	ControlCommandKinds,
	ControlCommandV1Schema,
	LauncherPresetSchema,
	RuntimeSignalKinds,
	RuntimeSignalV1Schema,
	jsonSchemaDocument,
	schemaManifest,
	stableJson,
} from "@golem/contracts";

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function body(value) {
	const { schema_version, ...rest } = value;
	return rest;
}

test("contract journey prevents incompatible v1 wire data from crossing process boundaries", async () => {
	for (const entry of ContractSchemaRegistry) {
		const fixture = ContractFixtures[entry.name];
		const accepted = entry.schema.safeParse(fixture.positive);
		assert.equal(accepted.success, true, `${entry.name} positive fixture must parse`);
		const roundTrip = JSON.parse(JSON.stringify(accepted.data));
		assert.deepEqual(roundTrip, accepted.data, `${entry.name} must survive JSON round-trip`);
		assert.equal(
			entry.schema.safeParse(fixture.negative).success,
			false,
			`${entry.name} negative fixture must reject`,
		);
		assert.doesNotThrow(
			() => jsonSchemaDocument(entry),
			`${entry.name} must convert to JSON Schema`,
		);
		assert.equal(
			await readFile(
				new URL(
					`../../packages/contracts/generated/json-schema/${entry.fileName}`,
					import.meta.url,
				),
				"utf8",
			),
			stableJson(jsonSchemaDocument(entry)),
			`${entry.name} snapshot must be deterministic`,
		);
	}

	const runtimeBase = clone(ContractFixtures["runtime-signal"].positive);
	const generation = runtimeBase.payload.generation;
	const project = { project_id: generation.project_id };
	const location = body(ContractFixtures["project-location-reference"].positive);
	const endpointRecord = body(ContractFixtures["endpoint-record"].positive);
	const endpoint = { endpoint_id: endpointRecord.endpoint_id, generation };
	const capability = body(ContractFixtures["capability-record"].positive);
	const runtimePayloads = {
		"project.observed": { kind: "project.observed", project, location },
		"session.started": { kind: "session.started", generation, metadata: {} },
		"session.resumed": { kind: "session.resumed", generation },
		"session.activity": { kind: "session.activity", generation, activity_kind: "work" },
		"session.idle": { kind: "session.idle", generation },
		"session.waiting": { kind: "session.waiting", generation, reason: "approval" },
		"session.metadata_patched": { kind: "session.metadata_patched", generation, metadata: {} },
		"session.ended": { kind: "session.ended", generation, disposition: "ended" },
		"endpoint.claimed": { kind: "endpoint.claimed", endpoint: endpointRecord },
		"endpoint.heartbeat": { kind: "endpoint.heartbeat", endpoint, heartbeat_at: runtimeBase.clocks.received_at },
		"endpoint.readiness_changed": { kind: "endpoint.readiness_changed", endpoint: endpointRecord },
		"endpoint.released": { kind: "endpoint.released", endpoint, reason: "closed" },
		"capabilities.reported": { kind: "capabilities.reported", project, capabilities: [capability] },
	};
	for (const kind of RuntimeSignalKinds) {
		assert.equal(
			RuntimeSignalV1Schema.safeParse({
				...runtimeBase,
				event_kind: kind,
				payload: runtimePayloads[kind],
			}).success,
			true,
			`runtime ${kind} discriminator must parse`,
		);
	}

	const controlBase = clone(ContractFixtures["control-command"].positive);
	const deliveryId = ContractFixtures["delivery-acknowledgement"].positive.delivery_id;
	const migrationId = ContractFixtures["migration-plan"].positive.plan_id;
	const controlPayloads = {
		"project.register": { kind: "project.register", project, location },
		"project.archive": { kind: "project.archive", project },
		"project.location_decide": { kind: "project.location_decide", project, location, decision: "attach" },
		"preset.upsert": {
			kind: "preset.upsert",
			preset_name: "review",
			preset: {
				name: "review",
				harness: "claude",
				backend: "anthropic",
				model_selector: "claude-sonnet",
				delivery_mode: "pull",
				native_args: ["--verbose"],
				env_key_refs: ["ANTHROPIC_API_KEY"],
			},
		},
		"preset.delete": { kind: "preset.delete", preset_name: "review" },
		"launch.prepare": { kind: "launch.prepare", harness: "claude" },
		"session.control": { kind: "session.control", generation, action: "interrupt" },
		"dispatch.enqueue": { kind: "dispatch.enqueue", endpoint, payload: { text: "hello" } },
		"dispatch.cancel": { kind: "dispatch.cancel", delivery_id: deliveryId },
		"dispatch.retry": { kind: "dispatch.retry", delivery_id: deliveryId },
		"migration.plan": { kind: "migration.plan", scope: "runtime" },
		"migration.apply": { kind: "migration.apply", plan_id: migrationId },
		"migration.rollback": { kind: "migration.rollback", plan_id: migrationId },
		"compatibility.cutover": { kind: "compatibility.cutover", stage: "C2" },
	};
	for (const kind of ControlCommandKinds) {
		assert.equal(
			ControlCommandV1Schema.safeParse({
				...controlBase,
				command_kind: kind,
				payload: controlPayloads[kind],
			}).success,
			true,
			`command ${kind} discriminator must parse`,
		);
	}

	const sessionControlPayloads = [
		{ kind: "session.control", generation, action: "interrupt" },
		{ kind: "session.control", generation, action: "halt" },
		{ kind: "session.control", generation, action: "resume" },
		{ kind: "session.control", generation, action: "rename", name: "Queue steward" },
		{ kind: "session.control", generation, action: "set_role", role: "manager" },
		{
			kind: "session.control",
			generation,
			action: "patch_metadata",
			metadata: { patch: { model: "gpt" }, clear_fields: ["legacy_model"] },
		},
	];
	for (const payload of sessionControlPayloads) {
		assert.equal(
			ControlCommandV1Schema.safeParse({
				...controlBase,
				command_kind: "session.control",
				payload,
			}).success,
			true,
			`session control ${payload.action} must require an explicit shape`,
		);
	}

	const incompatibleSignal = RuntimeSignalV1Schema.safeParse({
		...runtimeBase,
		payload: { kind: "session.metadata_patched", generation, metadata: { fn: () => {} } },
	});
	assert.equal(incompatibleSignal.success, false, "non-JSON payload must reject");

	const invalidResumedGeneration = RuntimeSignalV1Schema.safeParse({
		...runtimeBase,
		event_kind: "session.resumed",
		payload: {
			kind: "session.resumed",
			generation,
			resumed_from_generation_id: "legacy-generation-name",
		},
	});
	assert.equal(invalidResumedGeneration.success, false, "resumed generations must use opaque generation ids");
	assert.equal(
		invalidResumedGeneration.error.issues.some(
			(issue) => issue.path.join(".") === "payload.resumed_from_generation_id",
		),
		true,
		"resumed generation diagnostics must identify the opaque id field",
	);

	const crossScopeAlias = ContractFixtures["alias-reference"].negative;
	const aliasResult = ContractSchemaRegistry.find((entry) => entry.name === "alias-reference").schema.safeParse(crossScopeAlias);
	assert.equal(aliasResult.success, false, "cross-project aliases must reject");
	assert.equal(
		aliasResult.error.issues.some((issue) => issue.message === "wire.alias.cross_scope"),
		true,
		"cross-project aliases need a stable machine-readable issue",
	);

	const invalidClock = ContractSchemaRegistry.find((entry) => entry.name === "clock-facts").schema.safeParse(
		ContractFixtures["clock-facts"].negative,
	);
	assert.equal(invalidClock.success, false, "out-of-order clocks must reject");
	assert.equal(
		invalidClock.error.issues.some((issue) => issue.message === "wire.clock.observed_after_received"),
		true,
		"clock rejection must keep a stable issue",
	);

	const unknownMajor = ContractSchemaRegistry.find((entry) => entry.name === "project-location-reference").schema.safeParse(
		ContractFixtures["project-location-reference"].negative,
	);
	assert.equal(unknownMajor.success, false, "unknown wire majors must reject");
	assert.equal(
		unknownMajor.error.issues.some((issue) => issue.message === "wire.version.unknown_major"),
		true,
		"unknown wire major must be machine-readable",
	);

	const secretArgument = LauncherPresetSchema.safeParse(
		ContractFixtures["launcher-preset"].negative,
	);
	assert.equal(secretArgument.success, false, "launcher presets must reject secret values");
	assert.equal(
		secretArgument.error.issues.some(
			(issue) => issue.message === "config.secret_value.forbidden" && issue.path.join(".") === "native_args.0",
		),
		true,
		"secret diagnostics must identify the managed field path",
	);

	const splitSecretArgument = LauncherPresetSchema.safeParse({
		...ContractFixtures["launcher-preset"].positive,
		native_args: ["--api-key", "plain-secret"],
	});
	assert.equal(splitSecretArgument.success, false, "split secret arguments must reject");
	assert.equal(
		splitSecretArgument.error.issues.some(
			(issue) => issue.message === "config.secret_argument.forbidden" && issue.path.join(".") === "native_args.0",
		),
		true,
		"split secret diagnostics must identify the sensitive argument name",
	);
	assert.equal(
		splitSecretArgument.error.issues.some(
			(issue) => issue.message === "config.secret_value.forbidden" && issue.path.join(".") === "native_args.1",
		),
		true,
		"split secret diagnostics must identify the secret value",
	);

	const emptyUntypedPreset = ControlCommandV1Schema.safeParse({
		...controlBase,
		command_kind: "preset.upsert",
		payload: { kind: "preset.upsert", preset_name: "review", preset: {} },
	});
	assert.equal(emptyUntypedPreset.success, false, "preset mutation must require a typed launcher preset");

	const renameWithoutName = ControlCommandV1Schema.safeParse({
		...controlBase,
		command_kind: "session.control",
		payload: { kind: "session.control", generation, action: "rename" },
	});
	assert.equal(renameWithoutName.success, false, "rename commands must require a name");

	const roleWithoutValue = ControlCommandV1Schema.safeParse({
		...controlBase,
		command_kind: "session.control",
		payload: { kind: "session.control", generation, action: "set_role" },
	});
	assert.equal(roleWithoutValue.success, false, "role commands must require a typed role value");

	const invalidMetadataMutation = ControlCommandV1Schema.safeParse({
		...controlBase,
		command_kind: "session.control",
		payload: {
			kind: "session.control",
			generation,
			action: "patch_metadata",
			metadata: { patch: { model: "gpt" }, clear_fields: ["model"] },
		},
	});
	assert.equal(invalidMetadataMutation.success, false, "metadata mutations cannot patch and clear one field");
	assert.equal(
		invalidMetadataMutation.error.issues.some(
			(issue) => issue.message === "wire.session_metadata.patch_clear_conflict",
		),
		true,
		"metadata patch/clear conflicts need a stable machine-readable issue",
	);

	const compatibility = CompatibilityIngressV1Schema.safeParse(
		ContractFixtures["compatibility-ingress"].positive,
	);
	assert.equal(compatibility.success, true, "only documented compatibility ingress preserves additive fields");
	assert.equal(
		await readFile(
			new URL("../../packages/contracts/generated/json-schema/index.json", import.meta.url),
			"utf8",
		),
		stableJson(schemaManifest()),
		"registry index must remain deterministic",
	);
});
