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
	persistenceCompositionPort,
} from "@golem/persistence";
import { createTemporaryHome, waitFor } from "@golem/testkit";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ownerChild = path.join(repositoryRoot, "test/persistence/owner-child.mjs");
const boundaryFixture = path.join(
	repositoryRoot,
	"test/fixtures/persistence/owner-capability-boundary.mjs",
);
const require = createRequire(new URL("../../packages/persistence/package.json", import.meta.url));
const Database = require("better-sqlite3");
const openPersistenceForControlPlane = persistenceCompositionPort.open;

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
				location: "/temporary/fixture",
			},
			generation: {
				generationId: `gen_${id}`,
				sessionId: "ses_fixture",
				projectId: "prj_fixture",
				harness: "fixture",
				state: "working",
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
	let owner;
	let firstChild;
	try {
		const publicDeclarations = fs.readFileSync(
			path.join(repositoryRoot, "packages/persistence/dist/index.d.ts"),
			"utf8",
		);
		assert.match(
			publicDeclarations,
			/persistenceCompositionPort/,
			"the control-plane receives the narrow write composition port",
		);
		assert.doesNotMatch(
			publicDeclarations,
			/\b(?:PersistenceOwner|SqliteConnection|Kysely|runtimeSql|trackerSql|openPersistenceForControlPlane)\b/,
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
		const freshOwner = openPersistenceForControlPlane({
			runtimePath: fresh.runtimeDb,
			trackerPath: fresh.trackerDb,
		});
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
					runtimeVersion: 2,
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

		owner = openPersistenceForControlPlane({
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
		});
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
			"runtime-v1 metadata, watermark, disposition, and migration decision tables are owned by the v2 migration",
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
				"occurred_at",
				"received_at",
				"metadata_version",
				"disposition",
			],
			"runtime event metadata and disposition columns are explicit",
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
				runtime: 2,
				tracker: 0,
				foreignKeys: true,
				journal: "wal",
				busy: 2500,
				integrity: "ok",
				trackerBaseline: "unmanaged",
			},
			"separate real SQLite files apply the runtime-v1 metadata contract while opening tracker data unchanged",
		);
		assert.equal(fs.existsSync(`${home.trackerDb}.owner.lock`), false, "runtime lock is not attached to tracker data");
		assert.equal(fs.existsSync(home.runtimeDb), true);
		assert.equal(fs.existsSync(home.trackerDb), true);

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
			1,
			"post-commit crash retains canonical mutation",
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
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(owner.replayRuntimeOutbox(), 1, "expired outbox claims replay deterministically");
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
		assert.equal(count(backup, "runtime_events"), 1, "verified backup retains committed rows");
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
				1,
				"restored backup opens with committed rows",
			);
			assert.equal(restored.status().runtime.integrity, "ok");
		} finally {
			await restored.close();
		}
		await owner.close();
		owner = undefined;

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
				1,
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
			fs.existsSync(`${brokenPath}.owner.lock`),
			false,
			"constructor failures release the process-owner lock",
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
