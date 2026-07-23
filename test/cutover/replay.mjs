import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	applyCanonicalCutover,
	applyLegacyMigration,
	auditLegacyHome,
	canonicalCutoverStatus,
	evaluateCanonicalCutoverSoak,
	planCanonicalCutover,
	rollbackCanonicalCutover,
} from "@golem/compat";
import {
	readControlPlaneAuthority,
	resolveControlPlanePersistencePaths,
} from "@golem/persistence";
import { openLegacyMigrationPersistence } from "@golem/persistence/migration-compat";

import { upsertSessionFact } from "../../lib/session-facts.js";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fixture = path.join(
	repositoryRoot,
	"test",
	"fixtures",
	"migration",
	"strong-only",
);
const controlPlane = path.join(
	repositoryRoot,
	"apps",
	"control-plane",
	"dist",
	"main.js",
);
const staticRoot = path.join(
	repositoryRoot,
	"dashboard",
	"dist",
	"control-plane",
);

function temporaryHome() {
	const home = mkdtempSync(path.join(os.tmpdir(), "golem-gol57-cutover-"));
	cpSync(fixture, home, { recursive: true });
	return home;
}

function preflight(overrides = {}) {
	return { service_owners: 1, ...overrides };
}

async function preparedHome() {
	const home = temporaryHome();
	const seedDirectory = path.join(home, ".tracker-schema-seed");
	const seed = openLegacyMigrationPersistence({
		runtimePath: path.join(seedDirectory, "runtime.db"),
		trackerPath: path.join(home, "tracker.db"),
		lockPath: path.join(seedDirectory, "owner.lock"),
	});
	await seed.close();
	rmSync(seedDirectory, { recursive: true, force: true });
	const migrationPlan = await auditLegacyHome(home);
	await applyLegacyMigration({
		home,
		expected_plan_hash: migrationPlan.plan_hash,
	});
	return home;
}

function writeAuthority(home, value) {
	const target = path.join(home, "control-plane", "authority.json");
	writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function waitForReady(child, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		let output = "";
		let diagnostics = "";
		const timeout = setTimeout(() => {
			reject(
				new Error(
					`canonical control plane did not become ready: ${diagnostics}`,
				),
			);
		}, timeoutMs);
		const inspect = (chunk) => {
			output += chunk;
			for (;;) {
				const newline = output.indexOf("\n");
				if (newline === -1) break;
				const line = output.slice(0, newline);
				output = output.slice(newline + 1);
				try {
					const message = JSON.parse(line);
					if (
						message.type === "ready" &&
						typeof message.origin === "string"
					) {
						clearTimeout(timeout);
						resolve(message);
						return;
					}
				} catch {
					diagnostics += `${line}\n`;
				}
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", inspect);
		child.stderr.on("data", (chunk) => {
			diagnostics += chunk;
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(
				new Error(
					`canonical control plane exited before ready code=${code} signal=${signal}: ${diagnostics}`,
				),
			);
		});
	});
}

function stop(child) {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

async function proveTypedService(home) {
	const token = "gol57-control-plane-token-000000000000";
	const child = spawn(process.execPath, [controlPlane], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			GOLEM_HOME: home,
			GOLEM_CONTROL_PLANE_PORT: "0",
			GOLEM_CONTROL_PLANE_STATIC_ROOT: staticRoot,
			GOLEM_CONTROL_PLANE_TOKEN: token,
			GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID: "principal_local_operator",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const ready = await waitForReady(child);
		const health = await fetch(`${ready.origin}/api/health`);
		assert.equal(health.status, 200, "C4 typed service answers its real health route");
		const discovery = JSON.parse(
			readFileSync(path.join(home, "dashboard.json"), "utf8"),
		);
		assert.equal(discovery.mode, "canonical", "dashboard discovery labels canonical authority");
		assert.equal(discovery.generated, true, "dashboard discovery is a generated compatibility record");
	} finally {
		await stop(child);
	}
}

function failedGate(plan, code) {
	return plan.gates.find((gate) => gate.code === code && !gate.passed);
}

export async function runCanonicalCutoverCrashRollback() {
	const home = await preparedHome();
	const previousHome = process.env.GOLEM_HOME;
	process.env.GOLEM_HOME = home;
	try {
		const plan = await planCanonicalCutover({
			home,
			evidence: preflight(),
		});
		assert.equal(plan.eligible, true, "representative migrated home passes every C4 preflight gate");

		await assert.rejects(
			() =>
				applyCanonicalCutover({
					home,
					evidence: preflight(),
					expected_plan_hash: plan.plan_hash,
					failpoint: "after_quiesce",
				}),
			/canonical cutover failpoint after_quiesce/u,
			"crash after quiesce is visible",
		);
		assert.equal(
			readControlPlaneAuthority(home).write_policy,
			"quiesced",
			"crash leaves one durable fenced authority, never mixed writers",
		);
		assert.equal(
			canonicalCutoverStatus(home)?.phase,
			"quiesced",
			"restart has a durable resume point",
		);
		writeFileSync(
			path.join(home, "control-plane", ".cutover.lock"),
			`${JSON.stringify({ pid: 2_147_483_647, acquired_at: "2000-01-01T00:00:00.000Z" })}\n`,
			{ mode: 0o600 },
		);

		const resumed = await applyCanonicalCutover({
			home,
			evidence: preflight(),
			expected_plan_hash: plan.plan_hash,
		});
		assert.equal(resumed.resumed, true, "same exact plan resumes after the injected crash");
		assert.equal(resumed.authority.stage, "C4", "resume atomically selects canonical authority");
		assert.equal(resumed.authority.write_policy, "canonical_only");
		const paths = resolveControlPlanePersistencePaths(home);
		assert.equal(
			paths.runtimePath,
			path.join(home, "canonical", "runtime.db"),
			"C4 selects canonical runtime SQLite",
		);
		assert.equal(
			paths.trackerPath,
			path.join(home, "tracker.db"),
			"tracker remains its independent retained authority",
		);
		const projectionPath = path.join(
			home,
			"compatibility",
			"legacy-projection.json",
		);
		const projection = JSON.parse(readFileSync(projectionPath, "utf8"));
		assert.equal(projection.authoritative, false);
		assert.equal(projection.read_only, true);
		assert.equal(projection.canonical_revision, plan.canonical_revision);
		assert.equal(statSync(projectionPath).mode & 0o222, 0, "compatibility export has no write bits");

		await proveTypedService(home);

		const regressed = await evaluateCanonicalCutoverSoak(home, {
			health_ok: false,
			unsafe_backlog: 1,
		});
		assert.equal(regressed.rollback_triggered, true, "soak health/backlog regression invokes rollback policy");
		assert.equal(regressed.authority.stage, "C3");
		assert.equal(regressed.authority.write_policy, "legacy_open");
		assert.equal(
			existsSync(path.join(home, regressed.state.rollback_audit)),
			true,
			"rollback records a durable audit manifest",
		);
		assert.equal(
			existsSync(path.join(home, "canonical", "runtime.db")),
			true,
			"rollback preserves post-cutover canonical data instead of deleting it",
		);

		const recutoverPlan = await planCanonicalCutover({
			home,
			evidence: preflight(),
		});
		assert.equal(
			recutoverPlan.plan_hash,
			plan.plan_hash,
			"rollback leaves the exact deterministic re-cutover plan",
		);
		const recutover = await applyCanonicalCutover({
			home,
			evidence: preflight(),
			expected_plan_hash: recutoverPlan.plan_hash,
		});
		assert.equal(recutover.authority.stage, "C4");
		const idempotent = await applyCanonicalCutover({
			home,
			evidence: preflight(),
			expected_plan_hash: recutoverPlan.plan_hash,
		});
		assert.equal(idempotent.idempotent, true, "repeating the same C4 apply is idempotent");
		const stable = await evaluateCanonicalCutoverSoak(home);
		assert.equal(stable.state.phase, "stable", "healthy soak closes with one stable authority");
		await assert.rejects(
			() =>
				rollbackCanonicalCutover(home, {
					reason: "journey crash-recovery cleanup",
					failpoint: "after_authority",
				}),
			/canonical rollback failpoint after_authority/u,
			"crash after rollback authority switch is visible",
		);
		const rollbackPointer = readControlPlaneAuthority(home);
		assert.equal(rollbackPointer.stage, "C3");
		assert(rollbackPointer.rollback_audit);
		const resumedRollback = await rollbackCanonicalCutover(home, {
			reason: "resume rollback after crash",
		});
		assert.equal(resumedRollback.state.phase, "rolled_back");
		assert.equal(
			resumedRollback.state.rollback_audit,
			rollbackPointer.rollback_audit,
			"restart completes the existing audited rollback instead of creating or losing another snapshot",
		);

		return "representative SQLite home survives a crash and stale operation lock after quiesce, resumes the exact plan into one C4 authority, serves the real typed health route, emits revisioned read-only compatibility state, auto-rolls back on soak regression without deleting canonical data, re-cuts over idempotently, and resumes an audited rollback interrupted after its authority switch";
	} finally {
		if (previousHome === undefined) delete process.env.GOLEM_HOME;
		else process.env.GOLEM_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
}

export async function runLegacyWriterGuard() {
	const home = await preparedHome();
	const previousHome = process.env.GOLEM_HOME;
	process.env.GOLEM_HOME = home;
	try {
		const base = await planCanonicalCutover({
			home,
			evidence: preflight(),
		});
		const projectsPath = path.join(home, "projects.json");
		const projectsBytes = readFileSync(projectsPath);
		writeFileSync(projectsPath, Buffer.concat([projectsBytes, Buffer.from("\n")]));
		const staleImportPlan = await planCanonicalCutover({
			home,
			evidence: preflight(),
		});
		assert(
			failedGate(staleImportPlan, "cutover.final_import_current"),
			"a legacy delta after migration blocks cutover until the final exact snapshot is imported",
		);
		writeFileSync(projectsPath, projectsBytes);
		const injected = [
			[
				"cutover.parity_complete",
				{ parity_gaps: ["dashboard.deep-link"] },
			],
			["cutover.backlog_safe", { unsafe_backlog: 1 }],
			["cutover.single_owner", { service_owners: 2 }],
			[
				"cutover.presets_qualified",
				{
					presets: [
						{ preset: "codex/default", enabled: true, qualified: false },
					],
				},
			],
			["cutover.api_smoke", { api_smoke: false }],
			["cutover.ui_smoke", { ui_smoke: false }],
			["cutover.identity_conflicts", { strong_identity_conflicts: 1 }],
			[
				"cutover.binary_hash",
				{ expected_binary_hash: "0".repeat(64) },
			],
			[
				"cutover.schema_hash",
				{ expected_schema_hash: "0".repeat(64) },
			],
			[
				"cutover.migration_hash",
				{ expected_migration_hash: "0".repeat(64) },
			],
			["cutover.disk_space", { minimum_free_bytes: Number.MAX_SAFE_INTEGER }],
		];
		for (const [code, evidence] of injected) {
			const plan = await planCanonicalCutover({
				home,
				evidence: preflight(evidence),
			});
			assert(
				failedGate(plan, code),
				`${code} blocks with a stable remedy`,
			);
			await assert.rejects(
				() =>
					applyCanonicalCutover({
						home,
						evidence: preflight(evidence),
						expected_plan_hash: plan.plan_hash,
					}),
				(error) =>
					error?.code === "cutover.preflight_failed" &&
					error.gates?.some((gate) => gate.code === code),
			);
		}

		const projectionPath = path.join(
			home,
			"compatibility",
			"legacy-projection.json",
		);
		const projectionBytes = readFileSync(projectionPath);
		rmSync(projectionPath);
		const invariantPlan = await planCanonicalCutover({
			home,
			evidence: preflight(),
		});
		assert(failedGate(invariantPlan, "cutover.canonical_invariants"));
		writeFileSync(projectionPath, projectionBytes, { mode: 0o600 });

		const manifestPath = path.join(
			home,
			"migration-backups",
			base.migration_plan_hash.slice(0, 24),
			"manifest.json",
		);
		const manifest = readFileSync(manifestPath);
		rmSync(manifestPath);
		const backupPlan = await planCanonicalCutover({
			home,
			evidence: preflight(),
		});
		assert(failedGate(backupPlan, "cutover.backup_verified"));
		writeFileSync(manifestPath, manifest, { mode: 0o600 });

		await applyCanonicalCutover({
			home,
			evidence: preflight(),
			expected_plan_hash: base.plan_hash,
		});
		const factsPath = path.join(home, "session-facts.json");
		const before = existsSync(factsPath) ? readFileSync(factsPath) : null;
		assert.throws(
			() =>
				upsertSessionFact({
					canonical_id: "ses_forbidden",
					harness: "codex",
					locator: { raw_session_id: "forbidden" },
				}),
			(error) =>
				error?.code === "GOLEM_LEGACY_WRITER_RETIRED" &&
				/typed control-plane/u.test(error.remedy),
			"instrumented legacy registry writer rejects C4 with a stable typed remedy",
		);
		assert.deepEqual(
			existsSync(factsPath) ? readFileSync(factsPath) : null,
			before,
			"rejected writer changes no legacy bytes",
		);

		for (const entry of [
			path.join(repositoryRoot, "dashboard", "server", "index.js"),
			path.join(repositoryRoot, "mcp", "channel", "index.js"),
		]) {
			const result = await new Promise((resolve) => {
				const child = spawn(process.execPath, [entry], {
					cwd: repositoryRoot,
					env: { ...process.env, GOLEM_HOME: home },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stderr = "";
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				child.once("exit", (code, signal) =>
					resolve({ code, signal, stderr }),
				);
			});
			assert.notEqual(result.code, 0, `${path.basename(entry)} cannot start after C4`);
			assert.match(
				result.stderr,
				/GOLEM_LEGACY_WRITER_RETIRED/u,
				`${path.basename(entry)} reports the stable retired-writer code`,
			);
		}
		await rollbackCanonicalCutover(home, { reason: "guard journey cleanup" });
		chmodSync(projectionPath, 0o600);
		return "every injected backup/hash/parity/backlog/owner/preset/API/UI/disk/conflict/invariant gate blocks exact-hash apply; C4 rejects registry bytes and prevents legacy dashboard/channel processes from starting with one stable remedy";
	} finally {
		if (previousHome === undefined) delete process.env.GOLEM_HOME;
		else process.env.GOLEM_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
}
