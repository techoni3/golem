import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	PersistenceMigrationError,
	RuntimeFailpointError,
} from "@golem/persistence";
import { createTemporaryHome, waitFor } from "@golem/testkit";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ownerChild = path.join(repositoryRoot, "test/persistence/owner-child.mjs");
const boundaryFixture = path.join(
	repositoryRoot,
	"test/fixtures/persistence/owner-capability-boundary.mjs",
);
const alternateWriterFixture = path.join(
	repositoryRoot,
	"test/fixtures/persistence/control-plane-capability-boundary.mjs",
);
const require = createRequire(new URL("../../packages/persistence/package.json", import.meta.url));
const Database = require("better-sqlite3");
const openPersistenceForControlPlane = openControlPlanePersistence;

function createFixtureClock() {
	let value = "2026-07-20T00:00:00.000Z";
	return {
		now: () => value,
		after: (milliseconds) =>
			new Date(Date.parse(value) + milliseconds).toISOString(),
		set: (next) => {
			value = next;
		},
	};
}

function count(database, table) {
	return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function phaseCount(database) {
	return database
		.prepare("SELECT COUNT(*) AS count FROM tickets WHERE phase IS NOT NULL AND phase != ''")
		.get().count;
}

function inspectDatabase(target, inspect) {
	const database = new Database(target, { readonly: true, fileMustExist: true });
	try {
		return inspect(database);
	} finally {
		database.close();
	}
}

function tableNames(target) {
	return inspectDatabase(target, (database) =>
		database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all()
			.map((row) => row.name),
	);
}

function integrity(target) {
	return inspectDatabase(target, (database) =>
		database.pragma("integrity_check", { simple: true }),
	);
}

function childOwner(home, ownerId) {
	const child = spawn(process.execPath, [ownerChild], {
		cwd: repositoryRoot,
		detached: process.platform !== "win32",
		env: { ...home.env, GOLEM_OWNER_ID: ownerId },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return { child, stdout: () => stdout, stderr: () => stderr };
}

async function stopChild(group) {
	if (group.child.exitCode !== null) return;
	if (group.child.pid && process.platform !== "win32") process.kill(-group.child.pid, "SIGTERM");
	else group.child.kill("SIGTERM");
	await new Promise((resolve) => group.child.once("exit", resolve));
}

function eventInput(id, failpoint) {
	return {
		eventId: `evt_${id}`,
		deduplicationKey: `dedupe-${id}`,
		eventKind: "session.started",
		payload: { id },
		provenance: { adapter: "fixture" },
		occurredAt: "2026-07-20T00:00:00.000Z",
		mutation: {
			project: {
				projectId: "prj_fixture",
				name: "Fixture",
				locationId: "loc_fixture",
				canonicalPath: "/temporary/fixture",
				observedPath: "/observed/fixture",
				relation: "registered",
			},
			generation: {
				generationId: `gen_${id}`,
				sessionId: "ses_fixture",
				projectId: "prj_fixture",
				ordinal: id === "after" ? 1 : 2,
				harness: "claude",
				state: "active",
				lifecycleProvenance: {
					schemaVersion: "golem.lifecycle/v1",
					details: { producer: "fixture", event: "session.started" },
				},
				fieldProvenance: {
					schemaVersion: "golem.fields/v1",
					details: { producer: "fixture", fields: ["state"] },
				},
			},
		},
		outbox: { destination: "tracker", payload: { id } },
		...(failpoint ? { failpoint } : {}),
	};
}

function createRepresentativeTracker(target) {
	const database = new Database(target);
	try {
		database.exec(`
CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, phase TEXT NOT NULL);
CREATE TABLE comments (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE streams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE message_envelopes (id TEXT PRIMARY KEY, ticket_id TEXT);
INSERT INTO tickets VALUES ('GOL-legacy', 'legacy ticket', 'built');
INSERT INTO comments VALUES ('comment-legacy', 'GOL-legacy', 'preserve me');
INSERT INTO streams VALUES ('stream-legacy', 'legacy stream');
INSERT INTO message_envelopes VALUES ('envelope-legacy', 'GOL-legacy');
`);
	} finally {
		database.close();
	}
}

test("J3 SQLite owner, checksum migration, crash, backup, and restart recovery", async () => {
	const home = createTemporaryHome("golem-j3-persistence-");
	const fresh = createTemporaryHome("golem-j3-persistence-fresh-");
	const clock = createFixtureClock();
	let owner;
	let firstChild;
	try {
		const publicDeclarations = fs.readFileSync(
			path.join(repositoryRoot, "packages/persistence/dist/index.d.ts"),
			"utf8",
		);
		assert.doesNotMatch(
			publicDeclarations,
			/persistenceCompositionPort|openPersistenceForControlPlane/,
			"the public persistence contract cannot open a writable owner",
		);
		assert.doesNotMatch(
			publicDeclarations,
			/\b(?:PersistenceOwner|SqliteConnection|Kysely|runtimeSql|trackerSql)\b/,
			"public declarations do not leak owner construction or raw database handles",
		);
		const forbiddenImport = spawnSync(process.execPath, [boundaryFixture], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		assert.notEqual(
			forbiddenImport.status,
			0,
			"an adversarial package consumer cannot import the private owner or constructor",
		);
		assert.match(
			forbiddenImport.stderr,
			/ERR_PACKAGE_PATH_NOT_EXPORTED/,
		);
		const alternateWriterImport = spawnSync(process.execPath, [alternateWriterFixture], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		assert.notEqual(
			alternateWriterImport.status,
			0,
			"the public control-plane entry cannot be an alternate persistence writer",
		);
		assert.match(
			alternateWriterImport.stderr,
			/does not provide an export named 'openControlPlanePersistence'/,
		);
		assert.doesNotMatch(
			fs.readFileSync(
				path.join(repositoryRoot, "apps/control-plane/dist/index.d.ts"),
				"utf8",
			),
			/openControlPlanePersistence/,
			"the control-plane public declarations do not leak the construction capability",
		);
		const freshOwner = openPersistenceForControlPlane(
			{
				runtimePath: fresh.runtimeDb,
				trackerPath: fresh.trackerDb,
			},
			{ clock },
		);
		try {
			const freshStatus = freshOwner.status();
			assert.deepEqual(
				{
					runtimeVersion: freshStatus.runtime.userVersion,
					trackerVersion: freshStatus.tracker.userVersion,
					foreignKeys: freshStatus.runtime.foreignKeys && freshStatus.tracker.foreignKeys,
					journal: freshStatus.runtime.journalMode,
					busy: freshStatus.runtime.busyTimeoutMs,
					integrity: freshStatus.tracker.integrity,
				},
				{
					runtimeVersion: 1,
					trackerVersion: 1,
					foreignKeys: true,
					journal: "wal",
					busy: 2500,
					integrity: "ok",
				},
				"a fresh temporary home creates separate configured runtime and tracker databases",
			);
		} finally {
			await freshOwner.close();
		}

		const trackerSource = path.join(home.root, "legacy-tracker-source.db");
		createRepresentativeTracker(trackerSource);
		fs.copyFileSync(trackerSource, home.trackerDb);
		const before = new Database(trackerSource, { readonly: true });
		const beforeCounts = {
			tickets: count(before, "tickets"),
			phases: phaseCount(before),
			comments: count(before, "comments"),
			streams: count(before, "streams"),
			envelopes: count(before, "message_envelopes"),
		};
		before.close();
		const trackerBeforeOpen = fs.readFileSync(home.trackerDb);

		owner = openPersistenceForControlPlane(
			{
				runtimePath: home.runtimeDb,
				trackerPath: home.trackerDb,
			},
			{ clock },
		);
		assert.deepEqual(
			tableNames(home.runtimeDb).filter((name) =>
				[
					"producer_watermarks",
					"metadata_versions",
					"migration_runs",
					"migration_findings",
					"migration_decisions",
					"legacy_snapshots",
				].includes(name),
			),
			[
				"legacy_snapshots",
				"metadata_versions",
				"migration_decisions",
				"migration_findings",
				"migration_runs",
				"producer_watermarks",
			],
			"runtime-v1 metadata, watermark, disposition, and migration decision tables are owned by the canonical initial migration",
		);
		assert.deepEqual(
			inspectDatabase(home.runtimeDb, (database) =>
				database.prepare("PRAGMA table_info(runtime_events)").all().map((row) => row.name),
			),
			[
				"event_id",
				"deduplication_key",
				"event_kind",
				"payload_json",
				"provenance_json",
				"source_observed_at",
				"received_at",
				"materialized_at",
				"activity_at",
				"metadata_version",
				"disposition",
			],
			"source, receipt, materialization, activity, metadata, and disposition are separate runtime event facts",
		);
		assert.deepEqual(
			fs.readFileSync(home.trackerDb),
			trackerBeforeOpen,
			"opening an unmanaged legacy tracker is inspection-only before the explicit baseline",
		);
		const initial = owner.status();
		assert.deepEqual(
			{
				runtime: initial.runtime.userVersion,
				tracker: initial.tracker.userVersion,
				foreignKeys: initial.runtime.foreignKeys,
				journal: initial.runtime.journalMode,
				busy: initial.runtime.busyTimeoutMs,
				integrity: initial.runtime.integrity,
				trackerBaseline: initial.tracker.baseline,
			},
			{
				runtime: 1,
				tracker: 0,
				foreignKeys: true,
				journal: "wal",
				busy: 2500,
				integrity: "ok",
				trackerBaseline: "unmanaged",
			},
			"separate real SQLite files apply the runtime-v1 metadata contract while opening tracker data unchanged",
		);
		assert.equal(
			fs.existsSync(`${home.trackerDb}.owner.lock`),
			false,
			"runtime lock is not attached to tracker data",
		);
		assert.equal(
			fs.existsSync(`${home.runtimeDb}.owner.lock.guard`),
			true,
			"a nonce-bearing guard directory, rather than a replaceable diagnostic file, owns writes",
		);
		assert.match(
			fs.readFileSync(`${home.runtimeDb}.owner.lock`, "utf8"),
			/"nonce":"owner_/,
			"the diagnostic pointer reports the acquired owner nonce",
		);
		assert.equal(fs.existsSync(home.runtimeDb), true);
		assert.equal(fs.existsSync(home.trackerDb), true);

		const contractDatabase = new Database(home.runtimeDb);
		try {
			contractDatabase.pragma("foreign_keys = ON");
			const insertGeneration = ({
				id,
				sessionId,
				projectId,
				ordinal,
				state,
				harness = "claude",
			}) =>
				contractDatabase
					.prepare(
						"INSERT INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, 'golem.lifecycle/v1', '{}', 'golem.fields/v1', '{}', ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						sessionId,
						projectId,
						ordinal,
						harness,
						state,
						clock.now(),
						clock.now(),
						clock.now(),
						clock.now(),
						["ended", "errored", "superseded"].includes(state)
							? clock.now()
							: null,
					);
			const insertEndpoint = ({ id, generationId, state, readiness, revision }) =>
				contractDatabase
					.prepare(
						"INSERT INTO endpoint_claims(endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, claimed_at, heartbeat_at, expires_at, superseded_at) VALUES (?, ?, 'control', ?, ?, ?, 'owner-a', 'native_channel', ?, 'enabled', ?, NULL, NULL, ?)",
					)
					.run(
						id,
						generationId,
						revision,
						state,
						revision + 1,
						readiness,
						clock.now(),
						state === "superseded" ? clock.now() : null,
					);
			const insertAlias = ({
				projectId,
				harness = "claude",
				aliasKind = "native_conversation",
				producerId = null,
				alias,
				sessionId,
				generationId = null,
			}) =>
				contractDatabase
					.prepare(
						"INSERT INTO session_aliases(project_id, harness, alias_kind, producer_id, alias, session_id, generation_id, source, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'fixture', '{}', ?)",
					)
					.run(
						projectId,
						harness,
						aliasKind,
						producerId,
						alias,
						sessionId,
						generationId,
						clock.now(),
					);

			assert.equal(
				contractDatabase
					.prepare("PRAGMA table_info(project_locations)")
					.all()
					.find((column) => column.name === "location_id").type,
				"TEXT",
				"stable project locations use caller-provided TEXT identities",
			);
			assert.deepEqual(
				contractDatabase
					.prepare("PRAGMA table_info(session_generations)")
					.all()
					.map((column) => column.name),
				[
					"generation_id",
					"session_id",
					"project_id",
					"ordinal",
					"harness",
					"lifecycle_state",
					"lifecycle_schema_version",
					"lifecycle_provenance_json",
					"field_schema_version",
					"field_provenance_json",
					"source_observed_at",
					"received_at",
					"activity_at",
					"materialized_at",
					"ended_at",
				],
				"generations retain independent clocks and schema-versioned lifecycle/field provenance",
			);
			const insertLocation = ({
				locationId,
				projectId,
				canonicalPath,
				observedPath = null,
				relation,
			}) =>
				contractDatabase
					.prepare(
						"INSERT INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						locationId,
						projectId,
						canonicalPath,
						observedPath,
						relation,
						clock.now(),
						clock.now(),
					);
			const projectLocationColumns = contractDatabase
				.prepare("PRAGMA table_info(project_locations)")
				.all();
			assert.deepEqual(
				projectLocationColumns.map((column) => column.name),
				[
					"location_id",
					"project_id",
					"canonical_path",
					"observed_path",
					"relation",
					"source_observed_at",
					"created_at",
				],
				"project locations retain the exact GOL-26 canonical/observed/relation fields",
			);
			assert.equal(
				projectLocationColumns.find((column) => column.name === "observed_path")
					.notnull,
				0,
				"a project location may omit an untrusted raw observed path",
			);
			for (const [projectId, name, locationId, relation] of [
				["prj_contract", "Contract", "loc_text_identity", "main"],
				["prj_other", "Other", "loc_other", "registered"],
			]) {
				contractDatabase
					.prepare("INSERT INTO projects VALUES (?, ?, ?)")
					.run(projectId, name, clock.now());
				insertLocation({
					locationId,
					projectId,
					canonicalPath: `/${projectId}/canonical`,
					observedPath: `/${projectId}/observed`,
					relation,
				});
				contractDatabase
					.prepare("INSERT INTO logical_sessions VALUES (?, ?, '{}', ?)")
					.run(`ses_${projectId}`, projectId, clock.now());
			}
			for (const [locationId, relation] of [
				["loc_worktree", "worktree"],
				["loc_legacy", "legacy"],
			])
				insertLocation({
					locationId,
					projectId: "prj_contract",
					canonicalPath: `/prj_contract/${relation}`,
					relation,
				});
			assert.throws(
				() =>
					insertLocation({
						locationId: "loc_competing_relation",
						projectId: "prj_contract",
						canonicalPath: "/prj_contract/competing",
						relation: "canonical",
					}),
				/constraint/i,
				"project locations reject competing persistence-only relation values",
			);
			const lifecycle = [
				"starting",
				"idle",
				"active",
				"waiting",
				"ending",
				"ended",
				"errored",
				"superseded",
			];
			for (const [index, state] of lifecycle.entries())
				insertGeneration({
					id: `gen_lifecycle_${index}`,
					sessionId: "ses_prj_contract",
					projectId: "prj_contract",
					ordinal: index + 1,
					state,
				});
			insertGeneration({
				id: "gen_other",
				sessionId: "ses_prj_other",
				projectId: "prj_other",
				ordinal: 1,
				state: "starting",
			});
			contractDatabase
				.prepare("INSERT INTO logical_sessions VALUES (?, ?, '{}', ?)")
				.run("ses_prj_contract_second", "prj_contract", clock.now());
			insertGeneration({
				id: "gen_contract_second",
				sessionId: "ses_prj_contract_second",
				projectId: "prj_contract",
				ordinal: 1,
				state: "starting",
			});
			for (const [index, harness] of [
				"claude",
				"codex",
				"opencode",
				"pi",
			].entries())
				insertGeneration({
					id: `gen_harness_${harness}`,
					sessionId: "ses_prj_contract",
					projectId: "prj_contract",
					ordinal: 20 + index,
					state: "starting",
					harness,
				});
			assert.throws(
				() =>
					insertGeneration({
						id: "gen_unknown_harness",
						sessionId: "ses_prj_contract",
						projectId: "prj_contract",
						ordinal: 30,
						state: "starting",
						harness: "cursor",
					}),
				/constraint/i,
				"generation harnesses close over the exact GOL-26 set",
			);
			assert.equal(
				contractDatabase
					.prepare("SELECT COUNT(*) AS count FROM live_sessions WHERE lifecycle_state IN ('ended', 'errored', 'superseded')")
					.get().count,
				0,
				"canonical terminal generations are history-only, never live",
			);
			assert.throws(
				() =>
					insertGeneration({
						id: "gen_working",
						sessionId: "ses_prj_contract",
						projectId: "prj_contract",
						ordinal: 99,
						state: "working",
					}),
				/constraint/i,
				"the exact GOL-15 lifecycle rejects the removed working state",
			);
			assert.throws(
				() =>
					insertGeneration({
						id: "gen_cross_project",
						sessionId: "ses_prj_other",
						projectId: "prj_contract",
						ordinal: 100,
						state: "starting",
					}),
				/FOREIGN KEY/i,
				"generation ownership is enforced by the composite project/session key",
			);
			assert.throws(
				() =>
					contractDatabase
						.prepare("INSERT INTO location_aliases VALUES (?, ?, ?, 'path', ?, '{}')")
						.run("prj_contract", "loc_other", "/cross-alias", clock.now()),
				/FOREIGN KEY/i,
				"location aliases cannot claim a location from another project",
			);
			for (const [locationId, relatedLocationId] of [
				["loc_other", "loc_text_identity"],
				["loc_text_identity", "loc_other"],
			])
				assert.throws(
					() =>
						contractDatabase
							.prepare("INSERT INTO location_relations VALUES (?, ?, ?, 'worktree', ?, '{}')")
							.run("prj_contract", locationId, relatedLocationId, clock.now()),
					/FOREIGN KEY/i,
					"both relation endpoints stay within the owning project",
				);
			for (const [sessionId, generationId] of [
				["ses_prj_other", "gen_lifecycle_0"],
				["ses_prj_contract", "gen_other"],
				["ses_prj_contract", "gen_contract_second"],
			])
				assert.throws(
					() =>
						insertAlias({
							projectId: "prj_contract",
							producerId: `producer-${sessionId}`,
							alias: `alias-${generationId}`,
							sessionId,
							generationId,
						}),
					/FOREIGN KEY/i,
					"session aliases cannot cross-link project-owned sessions or generations, including a different same-project session",
				);
			for (const aliasKind of [
				"native_conversation",
				"native_run",
				"legacy_canonical_id",
				"supervisor_thread",
				"bridge_session",
				"migration_relation",
			])
				insertAlias({
					projectId: "prj_contract",
					aliasKind,
					producerId: `producer-${aliasKind}`,
					alias: `alias-${aliasKind}`,
					sessionId: "ses_prj_contract",
					generationId: "gen_lifecycle_0",
				});
			for (const harness of ["claude", "codex", "opencode", "pi"])
				insertAlias({
					projectId: "prj_contract",
					harness,
					producerId: `producer-${harness}`,
					alias: `harness-${harness}`,
					sessionId: "ses_prj_contract",
					generationId: "gen_lifecycle_0",
				});
			assert.throws(
				() =>
					insertAlias({
						projectId: "prj_contract",
						harness: "cursor",
						alias: "invalid-harness",
						sessionId: "ses_prj_contract",
						generationId: "gen_lifecycle_0",
					}),
				/constraint/i,
				"session aliases reject harnesses outside the exact GOL-26 set",
			);
			assert.throws(
				() =>
					insertAlias({
						projectId: "prj_contract",
						aliasKind: "native",
						alias: "invalid-kind",
						sessionId: "ses_prj_contract",
						generationId: "gen_lifecycle_0",
					}),
				/constraint/i,
				"session aliases reject competing persistence-only alias kinds",
			);
			insertAlias({
				projectId: "prj_contract",
				producerId: null,
				alias: "same-alias",
				sessionId: "ses_prj_contract",
				generationId: "gen_lifecycle_0",
			});
			assert.throws(
				() =>
					insertAlias({
						projectId: "prj_contract",
						producerId: null,
						alias: "same-alias",
						sessionId: "ses_prj_contract",
						generationId: "gen_lifecycle_0",
					}),
				/constraint/i,
				"unscoped aliases remain deterministically unique when producer scope is absent",
			);
			insertAlias({
				projectId: "prj_contract",
				producerId: "producer-a",
				alias: "same-alias",
				sessionId: "ses_prj_contract",
				generationId: "gen_lifecycle_0",
			});
			const endpointStates = ["claiming", "healthy", "degraded", "released", "expired", "superseded"];
			const readinessStates = [
				"ready",
				"held_busy",
				"held_waiting",
				"pull_only",
				"next_turn",
				"unsupported",
				"unhealthy",
				"uninitialized",
			];
			for (const [index, readiness] of readinessStates.entries())
				insertEndpoint({
					id: `endpoint_${index}`,
					generationId: `gen_lifecycle_${index}`,
					state: endpointStates[index % endpointStates.length],
					readiness,
					revision: index,
				});
			assert.throws(
				() =>
					insertEndpoint({
						id: "endpoint_legacy_active",
						generationId: "gen_other",
						state: "active",
						readiness: "ready",
						revision: 9,
					}),
				/constraint/i,
				"endpoint claims reject the removed persistence-only active state",
			);
			assert.throws(
				() =>
					insertEndpoint({
						id: "endpoint_legacy_busy",
						generationId: "gen_other",
						state: "healthy",
						readiness: "busy",
						revision: 10,
					}),
				/constraint/i,
				"endpoint readiness uses the exact shared GOL-15 vocabulary",
			);
			assert.throws(
				() =>
					insertEndpoint({
						id: "endpoint_duplicate_live",
						generationId: "gen_lifecycle_0",
						state: "healthy",
						readiness: "ready",
						revision: 11,
					}),
				/constraint/i,
				"one live endpoint route per generation is enforced by a partial unique index",
			);
			const insertCapability = ({
				id,
				endpointId,
				capability,
				qualification,
				readiness,
			}) =>
				contractDatabase
					.prepare(
						"INSERT INTO capability_observations(id, endpoint_id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, evidence_json, observed_at, expires_at) VALUES (?, ?, ?, 'fixture', '1', ?, 'native_channel', ?, 'probe', '{}', ?, NULL)",
					)
					.run(
						id,
						endpointId,
						capability,
						qualification,
						readiness,
						clock.now(),
					);
			assert.throws(
				() =>
					insertCapability({
						id: "cap_missing_endpoint",
						endpointId: "missing",
						capability: "dispatch",
						qualification: "supported",
						readiness: "ready",
					}),
				/FOREIGN KEY/i,
				"capability evidence retains a foreign-keyed endpoint owner",
			);
			for (const qualification of [
				"supported",
				"experimental",
				"unsupported",
				"unknown",
			])
				insertCapability({
					id: `cap_${qualification}`,
					endpointId: "endpoint_0",
					capability: `dispatch_${qualification}`,
					qualification,
					readiness: "ready",
				});
			assert.throws(
				() =>
					insertCapability({
						id: "cap_competing_qualification",
						endpointId: "endpoint_0",
						capability: "competing_qualification",
						qualification: "qualified",
						readiness: "ready",
					}),
				/constraint/i,
				"capability qualification rejects competing persistence-only values",
			);
			assert.throws(
				() =>
					insertCapability({
						id: "cap_mismatched_readiness",
						endpointId: "endpoint_0",
						capability: "mismatched_readiness",
						qualification: "supported",
						readiness: "held_busy",
					}),
				/FOREIGN KEY/i,
				"capability readiness is relationally bound to the endpoint readiness fact",
			);
			contractDatabase
				.prepare("INSERT INTO commands VALUES (?, ?, '{}', 'accepted', ?)")
				.run("cmd_contract", "cmd-contract", clock.now());
			contractDatabase
				.prepare("INSERT INTO delivery_envelopes VALUES (?, ?, ?, '{}', 'pending', ?)")
				.run("delivery_contract", "cmd_contract", "endpoint_0", clock.now());
			contractDatabase
				.prepare("INSERT INTO migration_runs VALUES (?, 'runtime', 'plan', 'planned', NULL, ?, NULL)")
				.run("migration_contract", clock.now());
			contractDatabase
				.prepare("INSERT INTO migration_decisions VALUES (?, ?, NULL, 'approved', ?)")
				.run("decision_contract", "migration_contract", clock.now());
			for (const statement of [
				"INSERT INTO commands VALUES ('cmd_invalid', 'cmd-invalid', '{}', 'anything-goes', 'now')",
				"INSERT INTO delivery_envelopes VALUES ('delivery_invalid', 'cmd_contract', 'endpoint_0', '{}', 'anything-goes', 'now')",
				"INSERT INTO migration_runs VALUES ('migration_invalid', 'runtime', 'plan', 'anything-goes', NULL, 'now', NULL)",
				"INSERT INTO migration_decisions VALUES ('decision_invalid', 'migration_contract', NULL, 'anything-goes', 'now')",
			])
				assert.throws(
					() => contractDatabase.exec(statement),
					/constraint/i,
					"runtime recovery/control records reject unknown closed-vocabulary values",
				);
		} finally {
			contractDatabase.close();
		}

		const trackerBeforeDryRun = fs.readFileSync(home.trackerDb);
		const trackerDryRun = owner.plan("tracker");
		assert.equal(trackerDryRun.mode, "dry-run");
		assert.equal(trackerDryRun.requiresBackup, true);
		assert.equal(trackerDryRun.pending[0].id, "tracker/001-baseline");
		assert.deepEqual(
			trackerDryRun.dryRun,
			{
				integrity: "ok",
				foreignKeyViolations: 0,
				applied: ["tracker/001-baseline"],
			},
			"dry-run clones, applies, and verifies the tracker migration before source apply",
		);
		assert.deepEqual(
			fs.readFileSync(home.trackerDb),
			trackerBeforeDryRun,
			"dry-run leaves the source tracker bytes unchanged",
		);
		assert.throws(
			() => owner.apply("tracker", undefined),
			(error) =>
				error instanceof PersistenceMigrationError &&
				error.code === "plan_mismatch",
			"apply requires an explicit dry-run plan hash",
		);
		assert.deepEqual(
			fs.readFileSync(home.trackerDb),
			trackerBeforeDryRun,
			"an omitted approval hash cannot configure, back up, ledger, or mutate tracker bytes",
		);
		assert.throws(
			() => owner.apply("tracker", "not-the-approved-plan"),
			(error) =>
				error instanceof PersistenceMigrationError &&
				error.code === "plan_mismatch",
			"apply refuses a plan that was not the approved dry-run",
		);
		const trackerApply = owner.apply("tracker", trackerDryRun.planHash);
		assert.equal(trackerApply.applied[0], "tracker/001-baseline");
		assert.equal(fs.existsSync(trackerApply.backupPath), true, "apply verifies a pre-migration backup");
		assert.deepEqual(
			inspectDatabase(home.trackerDb, (after) => ({
				tickets: count(after, "tickets"),
				phases: phaseCount(after),
				comments: count(after, "comments"),
				streams: count(after, "streams"),
				envelopes: count(after, "message_envelopes"),
			})),
			beforeCounts,
			"tracker baseline records migration ownership without rewriting legacy rows",
		);

		assert.throws(
			() => owner.recordRuntimeTransaction(eventInput("before", "before_commit")),
			RuntimeFailpointError,
		);
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) => count(database, "runtime_events")),
			0,
			"pre-commit crash keeps raw event out",
		);
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) => count(database, "runtime_outbox")),
			0,
			"pre-commit crash keeps outbox out",
		);
		clock.set("2026-07-20T00:00:05.000Z");
		assert.throws(
			() => owner.recordRuntimeTransaction(eventInput("after", "after_commit")),
			RuntimeFailpointError,
		);
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) => count(database, "runtime_events")),
			1,
			"post-commit crash retains source event",
		);
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) => count(database, "projects")),
			3,
			"post-commit crash retains canonical mutation",
		);
		assert.deepEqual(
			inspectDatabase(home.runtimeDb, (database) => ({
				event: database
					.prepare("SELECT source_observed_at, received_at, materialized_at, activity_at FROM runtime_events WHERE event_id = 'evt_after'")
					.get(),
				generation: database
					.prepare("SELECT source_observed_at, received_at, materialized_at, activity_at, lifecycle_schema_version, field_schema_version FROM session_generations WHERE generation_id = 'gen_after'")
					.get(),
			})),
			{
				event: {
					source_observed_at: "2026-07-20T00:00:00.000Z",
					received_at: "2026-07-20T00:00:05.000Z",
					materialized_at: "2026-07-20T00:00:05.000Z",
					activity_at: "2026-07-20T00:00:00.000Z",
				},
				generation: {
					source_observed_at: "2026-07-20T00:00:00.000Z",
					received_at: "2026-07-20T00:00:05.000Z",
					materialized_at: "2026-07-20T00:00:05.000Z",
					activity_at: "2026-07-20T00:00:00.000Z",
					lifecycle_schema_version: "golem.lifecycle/v1",
					field_schema_version: "golem.fields/v1",
				},
			},
			"repository writes retain producer clocks while the injected persistence clock owns receipt and materialization",
		);
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) => count(database, "runtime_outbox")),
			1,
			"post-commit crash retains durable cross-db outbox",
		);
		assert.equal(owner.recordRuntimeTransaction(eventInput("after")).disposition, "duplicate");
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) => count(database, "runtime_outbox")),
			1,
			"dedupe suppresses a second outbox record",
		);
		const firstClaim = owner.claimRuntimeOutbox("journey-worker", 1, 1);
		assert.equal(firstClaim.length, 1, "outbox claim is bounded to the requested row count");
		assert.throws(
			() => owner.claimRuntimeOutbox("journey-worker", 101),
			/limit must be an integer from 1 to 100/,
			"outbox claims reject unbounded work",
		);
		clock.set("2026-07-20T00:00:06.000Z");
		assert.equal(owner.replayRuntimeOutbox(), 1, "expired outbox claims replay deterministically");
		assert.equal(
			owner.claimRuntimeOutbox("journey-worker", 1).length,
			0,
			"replayed work observes its durable next-at backoff before it is eligible again",
		);
		clock.set("2026-07-20T00:00:07.000Z");
		const replayedClaim = owner.claimRuntimeOutbox("journey-worker", 1);
		assert.equal(replayedClaim.length, 1);
		assert.equal(
			owner.ackRuntimeOutbox(replayedClaim[0].id, replayedClaim[0].claimToken),
			true,
			"outbox acknowledgement is guarded by the active claim token",
		);
		assert.equal(
			inspectDatabase(home.runtimeDb, (database) =>
				database
					.prepare("SELECT status FROM runtime_outbox WHERE id = ?")
					.get(replayedClaim[0].id).status,
			),
			"published",
		);
		owner.recordRuntimeTransaction(eventInput("retry"));
		let retryClaim = owner.claimRuntimeOutbox("journey-worker", 1);
		assert.equal(retryClaim.length, 1);
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const failure = owner.failRuntimeOutbox(
				retryClaim[0].id,
				retryClaim[0].claimToken,
				`attempt-${attempt}`,
			);
			assert.equal(failure?.attempts, attempt);
			if (attempt === 5) {
				assert.equal(failure?.status, "permanent_failure");
				assert.ok(
					failure?.permanentFailureAt,
					"the bounded final failure remains observable",
				);
				break;
			}
			assert.equal(failure?.status, "pending");
			assert.ok(failure?.nextAttemptAt, "retry schedules a durable next-at value");
			clock.set(failure.nextAttemptAt);
			retryClaim = owner.claimRuntimeOutbox("journey-worker", 1);
			assert.equal(retryClaim.length, 1);
		}
		assert.equal(
			owner.claimRuntimeOutbox("journey-worker", 1).length,
			0,
			"a permanent failure cannot be replayed or reclaimed",
		);
		assert.deepEqual(
			inspectDatabase(home.runtimeDb, (database) =>
				database
					.prepare(
						"SELECT status, attempts, next_attempt_at, permanent_failure_at, last_error FROM runtime_outbox WHERE id = ?",
					)
					.get(retryClaim[0].id),
			),
			{
				status: "permanent_failure",
				attempts: 5,
				next_attempt_at: null,
				permanent_failure_at: clock.now(),
				last_error: "attempt-5",
			},
			"attempt cap, permanent disposition, and terminal diagnostic are durable",
		);
		assert.equal(
			inspectDatabase(home.trackerDb, (database) =>
				database
					.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_outbox'")
					.get().count,
			),
			0,
			"runtime outbox does not claim a cross-file transaction",
		);

		const runtimeBackup = owner.checkpointAndBackup("runtime");
		assert.equal(fs.existsSync(runtimeBackup), true);
		const backup = new Database(runtimeBackup, { readonly: true });
		assert.equal(count(backup, "runtime_events"), 2, "verified backup retains committed rows");
		assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
		assert.equal(backup.prepare("PRAGMA foreign_key_check").all().length, 0);
		backup.close();
		const restoredRuntime = path.join(home.root, "runtime-restored.db");
		fs.copyFileSync(runtimeBackup, restoredRuntime);
		const restored = openPersistenceForControlPlane({
			runtimePath: restoredRuntime,
			trackerPath: path.join(home.root, "restored-tracker.db"),
		});
		try {
			assert.equal(
				inspectDatabase(restoredRuntime, (database) => count(database, "runtime_events")),
				2,
				"restored backup opens with committed rows",
			);
			assert.equal(restored.status().runtime.integrity, "ok");
		} finally {
			await restored.close();
		}
		const replacementPointer = `${JSON.stringify({
			owner_id: "replacement-owner",
			pid: 999_999,
			nonce: "owner_00000000-0000-0000-0000-000000000000",
			acquired_at: clock.now(),
		})}\n`;
		fs.writeFileSync(`${home.runtimeDb}.owner.lock`, replacementPointer);
		await owner.close();
		owner = undefined;
		assert.equal(
			fs.readFileSync(`${home.runtimeDb}.owner.lock`, "utf8"),
			replacementPointer,
			"release carries the acquired nonce and cannot delete a replacement diagnostic pointer",
		);

		firstChild = childOwner(home, "winner");
		await waitFor(() => firstChild.stdout().includes('"ready"') ? true : undefined, "first SQLite owner readiness");
		const loser = childOwner(home, "loser");
		await new Promise((resolve) => loser.child.once("exit", resolve));
		assert.equal(loser.child.exitCode, 41, `second owner must lose: ${loser.stderr()}`);
		assert.match(loser.stderr(), /owner_conflict/);
		await stopChild(firstChild);
		firstChild = undefined;
		const crashChild = childOwner(home, "crash-boundary");
		await waitFor(
			() => crashChild.stdout().includes('"ready"') ? true : undefined,
			"crash owner readiness",
		);
		if (crashChild.child.pid && process.platform !== "win32")
			process.kill(-crashChild.child.pid, "SIGKILL");
		else crashChild.child.kill("SIGKILL");
		await new Promise((resolve) => crashChild.child.once("exit", resolve));
		assert.notEqual(crashChild.child.exitCode, 0, "real child crash leaves no graceful shutdown path");

		const restarted = openPersistenceForControlPlane({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb });
		try {
			assert.equal(
				inspectDatabase(home.runtimeDb, (database) => count(database, "runtime_events")),
				2,
				"restart after a child crash reclaims the stale owner lock and preserves the committed event",
			);
			assert.equal(restarted.status().runtime.integrity, "ok");
			assert.equal(restarted.status().runtime.foreignKeyViolations, 0);
		} finally {
			await restarted.close();
		}

		const driftPath = path.join(home.root, "drift-runtime.db");
		const drift = new Database(driftPath);
		drift.exec("CREATE TABLE golem_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
		drift.prepare("INSERT INTO golem_migrations VALUES (?, ?, ?)").run("runtime/001-initial", "not-the-source-checksum", "2026-07-20T00:00:00.000Z");
		drift.pragma("user_version = 1");
		drift.close();
		const driftBytes = fs.readFileSync(driftPath);
		assert.throws(
			() => openPersistenceForControlPlane({ runtimePath: driftPath, trackerPath: path.join(home.root, "drift-tracker.db") }),
			(error) => error instanceof PersistenceMigrationError && error.code === "checksum_drift",
		);
		const driftVerify = new Database(driftPath, { readonly: true });
		assert.equal(count(driftVerify, "golem_migrations"), 1, "checksum refusal leaves source untouched");
		driftVerify.close();
		assert.deepEqual(fs.readFileSync(driftPath), driftBytes);
		assert.equal(integrity(driftPath), "ok");

		const newerPath = path.join(home.root, "newer-runtime.db");
		const newer = new Database(newerPath);
		newer.pragma("user_version = 99");
		newer.close();
		const newerBytes = fs.readFileSync(newerPath);
		assert.throws(
			() => openPersistenceForControlPlane({ runtimePath: newerPath, trackerPath: path.join(home.root, "newer-tracker.db") }),
			(error) => error instanceof PersistenceMigrationError && error.code === "schema_too_new",
		);
		assert.deepEqual(fs.readFileSync(newerPath), newerBytes);
		assert.equal(integrity(newerPath), "ok");

		const malformedLedgerPath = path.join(home.root, "malformed-ledger.db");
		const malformedLedger = new Database(malformedLedgerPath);
		malformedLedger.exec(
			"CREATE TABLE golem_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		malformedLedger
			.prepare("INSERT INTO golem_migrations VALUES (?, ?, ?)")
			.run("", "checksum", "2026-07-20T00:00:00.000Z");
		malformedLedger.close();
		const malformedLedgerBytes = fs.readFileSync(malformedLedgerPath);
		assert.throws(
			() =>
				openPersistenceForControlPlane({
					runtimePath: malformedLedgerPath,
					trackerPath: path.join(home.root, "malformed-ledger-tracker.db"),
				}),
			(error) =>
				error instanceof PersistenceMigrationError &&
				error.code === "migration_ledger_invalid",
			"malformed migration ledger rows are rejected before source writes",
		);
		assert.deepEqual(fs.readFileSync(malformedLedgerPath), malformedLedgerBytes);
		assert.equal(integrity(malformedLedgerPath), "ok");

		const unknownLedgerPath = path.join(home.root, "unknown-ledger.db");
		const unknownLedger = new Database(unknownLedgerPath);
		unknownLedger.exec(
			"CREATE TABLE golem_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		unknownLedger
			.prepare("INSERT INTO golem_migrations VALUES (?, ?, ?)")
			.run("runtime/999-unknown", "checksum", "2026-07-20T00:00:00.000Z");
		unknownLedger.close();
		const unknownLedgerBytes = fs.readFileSync(unknownLedgerPath);
		assert.throws(
			() =>
				openPersistenceForControlPlane({
					runtimePath: unknownLedgerPath,
					trackerPath: path.join(home.root, "unknown-ledger-tracker.db"),
				}),
			(error) =>
				error instanceof PersistenceMigrationError &&
				error.code === "schema_too_new",
			"unknown migration ledger rows are rejected before source writes",
		);
		assert.deepEqual(fs.readFileSync(unknownLedgerPath), unknownLedgerBytes);
		assert.equal(integrity(unknownLedgerPath), "ok");

		const brokenPath = path.join(home.root, "broken-runtime.db");
		const broken = new Database(brokenPath);
		broken.exec("CREATE TABLE runtime_events (only_column TEXT NOT NULL)");
		broken.close();
		assert.throws(
			() => openPersistenceForControlPlane({ runtimePath: brokenPath, trackerPath: path.join(home.root, "broken-tracker.db") }),
			(error) => error instanceof PersistenceMigrationError && error.code === "migration_failed",
		);
		const brokenVerify = new Database(brokenPath, { readonly: true });
		assert.equal(
			brokenVerify
				.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
				.get().count,
			0,
			"a failed migration rolls back every partial source-table change",
		);
		brokenVerify.close();
		assert.equal(
			fs.existsSync(`${brokenPath}.owner.lock.guard`),
			false,
			"constructor failures release their nonce-bearing process-owner guard",
		);
		const sourceVerify = new Database(trackerSource, { readonly: true });
		assert.deepEqual(
			{
				tickets: count(sourceVerify, "tickets"),
				phases: phaseCount(sourceVerify),
				comments: count(sourceVerify, "comments"),
				streams: count(sourceVerify, "streams"),
				envelopes: count(sourceVerify, "message_envelopes"),
				migrationLedger: sourceVerify
					.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'golem_migrations'")
					.get().count,
			},
			{ ...beforeCounts, migrationLedger: 0 },
			"tracker migration operates on a copy and leaves the representative source fixture unchanged",
		);
		sourceVerify.close();
	} finally {
		if (firstChild) await stopChild(firstChild);
		if (owner) await owner.close();
		home.cleanup();
		fresh.cleanup();
		assert.equal(fs.existsSync(home.root), false, "journey cleanup removes all temporary SQLite state");
		assert.equal(fs.existsSync(fresh.root), false, "fresh fixture cleanup removes all temporary SQLite state");
	}
});
