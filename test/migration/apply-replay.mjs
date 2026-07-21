import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	applyLegacyMigration,
	auditLegacyHome,
} from "@golem/compat";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(repositoryRoot, "test", "fixtures", "migration");
const golemCli = path.join(repositoryRoot, "cli", "golem.js");
const hostileCredentialSegment = "ghp-abcdef1234567890";

function copyFixture(name) {
	const home = mkdtempSync(path.join(os.tmpdir(), "golem-gol52-migration-"));
	cpSync(path.join(fixtures, name), home, { recursive: true });
	return home;
}

function copyHostileFixture(name) {
	const parent = mkdtempSync(path.join(os.tmpdir(), "golem-gol52-hostile-"));
	const home = path.join(parent, hostileCredentialSegment, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	cpSync(path.join(fixtures, name), home, { recursive: true });
	const projectsPath = path.join(home, "projects.json");
	const projects = JSON.parse(readFileSync(projectsPath, "utf8"));
	projects.projects[0].path = `/Volumes/${hostileCredentialSegment}/acme`;
	writeFileSync(projectsPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
	return { home, parent };
}

function bytes(home, relative) {
	return readFileSync(path.join(home, relative));
}

function migrationCliResult(home, args, { json = true } = {}) {
	return spawnSync(
		process.execPath,
		[
			golemCli,
			"migrate",
			...args,
			"--home",
			home,
			...(json ? ["--json"] : []),
		],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
		},
	);
}

function migrationCli(home, args) {
	const result = migrationCliResult(home, args);
	assert.equal(result.status, 0, `root golem migrate ${args.join(" ")} exits successfully: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

function assertCredentialRedacted(result, command) {
	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(
		output.includes(hostileCredentialSegment),
		false,
		`${command} output must never expose the hostile credential-shaped home segment`,
	);
}

function runHostileTemporaryHomeProbe() {
	const happy = copyHostileFixture("strong-only");
	const text = copyHostileFixture("strong-only");
	const failing = copyHostileFixture("strong-only");
	try {
		const planResult = migrationCliResult(happy.home, ["plan"]);
		assert.equal(planResult.status, 0, `hostile home plan succeeds: ${planResult.stderr}`);
		assertCredentialRedacted(planResult, "plan");
		const plan = JSON.parse(planResult.stdout);

		const applyResult = migrationCliResult(happy.home, ["apply", "--plan-hash", plan.plan_hash]);
		assert.equal(applyResult.status, 0, `hostile home apply succeeds: ${applyResult.stderr}`);
		assertCredentialRedacted(applyResult, "apply");
		const applied = JSON.parse(applyResult.stdout);
		assert.equal(applied.backup_directory.includes(hostileCredentialSegment), false, "apply status redacts backup path");
		assert.equal(applied.compatibility_projection.includes(hostileCredentialSegment), false, "apply status redacts compatibility path");
		assert.equal(applied.rollback_command.includes(hostileCredentialSegment), false, "apply status redacts rollback command");
		const projection = readFileSync(path.join(happy.home, "compatibility", "legacy-projection.json"), "utf8");
		assert.equal(projection.includes(hostileCredentialSegment), false, "generated projection redacts credential-shaped project locations");
		const durableStatus = readFileSync(path.join(happy.home, "migration-status.json"), "utf8");
		assert.equal(durableStatus.includes(hostileCredentialSegment), false, "durable status does not retain a raw hostile home path");

		const statusResult = migrationCliResult(happy.home, ["status"]);
		assert.equal(statusResult.status, 0, `hostile home status succeeds: ${statusResult.stderr}`);
		assertCredentialRedacted(statusResult, "status");
		const rollbackResult = migrationCliResult(happy.home, ["rollback"]);
		assert.equal(rollbackResult.status, 0, `hostile home rollback succeeds: ${rollbackResult.stderr}`);
		assertCredentialRedacted(rollbackResult, "rollback");

		const textPlanResult = migrationCliResult(text.home, ["plan"], { json: false });
		assert.equal(textPlanResult.status, 0, `hostile text plan succeeds: ${textPlanResult.stderr}`);
		assertCredentialRedacted(textPlanResult, "text plan");
		const textPlanHash = /^hash:\s+([0-9a-f]{64})$/mu.exec(
			textPlanResult.stdout,
		)?.[1];
		assert.ok(textPlanHash, "text plan exposes the exact hash without exposing the hostile home");
		const textApplyResult = migrationCliResult(
			text.home,
			["apply", "--plan-hash", textPlanHash],
			{ json: false },
		);
		assert.equal(textApplyResult.status, 0, `hostile text apply succeeds: ${textApplyResult.stderr}`);
		assertCredentialRedacted(textApplyResult, "text apply");
		const textStatusResult = migrationCliResult(text.home, ["status"], { json: false });
		assert.equal(textStatusResult.status, 0, `hostile text status succeeds: ${textStatusResult.stderr}`);
		assertCredentialRedacted(textStatusResult, "text status");
		const textRollbackResult = migrationCliResult(text.home, ["rollback"], { json: false });
		assert.equal(textRollbackResult.status, 0, `hostile text rollback succeeds: ${textRollbackResult.stderr}`);
		assertCredentialRedacted(textRollbackResult, "text rollback");

		const failingPlan = migrationCliResult(failing.home, ["plan"]);
		assert.equal(failingPlan.status, 0, `hostile error probe plan succeeds: ${failingPlan.stderr}`);
		assertCredentialRedacted(failingPlan, "error-probe plan");
		const failurePlan = JSON.parse(failingPlan.stdout);
		writeFileSync(path.join(failing.home, "migration-backups"), "block backup directory", { mode: 0o600 });
		const errorResult = migrationCliResult(failing.home, ["apply", "--plan-hash", failurePlan.plan_hash]);
		assert.equal(errorResult.status, 3, "hostile backup failure returns the typed CLI failure status");
		assert.match(errorResult.stderr, /migration\.backup_failed/u, "hostile backup failure preserves the typed error code");
		assertCredentialRedacted(errorResult, "apply error");
	} finally {
		rmSync(happy.parent, { recursive: true, force: true });
		rmSync(text.parent, { recursive: true, force: true });
		rmSync(failing.parent, { recursive: true, force: true });
	}
}

export async function runMigrationApplyReplay() {
	const strongOnly = copyFixture("strong-only");
	const old = copyFixture("old");
	const current = copyFixture("current");
	const malformed = copyFixture("malformed");
	try {
		const sourceBefore = bytes(strongOnly, "projects.json");
		const plan = migrationCli(strongOnly, ["plan"]);
		const applied = { status: migrationCli(strongOnly, ["apply", "--plan-hash", plan.plan_hash]) };
		assert.equal(applied.status.status, "applied", "strong legacy evidence imports only after the exact dry-run hash is rechecked");
		assert.deepEqual(applied.status.imported, { projects: 1, sessions: 1, generations: 1, aliases: 1 }, "one old representative project/session is materialized through canonical typed storage");
		assert.equal(Buffer.compare(sourceBefore, bytes(strongOnly, "projects.json")), 0, "apply leaves legacy source bytes untouched");
		assert.equal(existsSync(path.join(strongOnly, "canonical", "runtime.db")), true, "canonical SQLite target is populated separately from legacy inputs");
		const projection = JSON.parse(readFileSync(path.join(strongOnly, "compatibility", "legacy-projection.json"), "utf8"));
		assert.equal(projection.generated, true, "compatibility export is explicitly generated");
		assert.equal(projection.projects.length, 1, "projection is reproduced from canonical project state");
		assert.equal(projection.sessions.length, 1, "projection is reproduced from canonical session state");
		assert.equal(migrationCli(strongOnly, ["status"])?.plan_hash, plan.plan_hash, "status exposes the applied exact plan without opening legacy sources as writers");
		const rolledBack = migrationCli(strongOnly, ["rollback"]);
		assert.equal(rolledBack.status, "rolled_back", "rollback records an explicit durable state");
		assert.equal(existsSync(path.join(strongOnly, "canonical")), false, "rollback restores the pre-apply canonical pointer instead of reverse-inferencing legacy state");

		const oldPlan = await auditLegacyHome(old);
		assert.equal(oldPlan.actions.some((action) => action.reason === "compat.config.typed_importer_required" && action.kind === "review"), true, "present config with no typed importer is an explicit pre-apply review gate");
		await assert.rejects(
			() => applyLegacyMigration({ home: old, expected_plan_hash: oldPlan.plan_hash }),
			(error) => error?.code === "migration.review_required",
			"unsupported present stores never succeed as an evidence-only snapshot",
		);
		assert.equal(existsSync(path.join(old, "canonical")), false, "unsupported-store review creates no canonical state");

		const currentPlan = await auditLegacyHome(current);
		for (const source of ["config", "channels", "journals"]) {
			assert.equal(
				currentPlan.actions.some(
					(action) =>
						action.reason === `compat.${source}.typed_importer_required` &&
						action.kind === "review",
				),
				true,
				`present ${source} source with no typed importer is an explicit pre-apply review gate`,
			);
		}
		const unsupportedBefore = {
			config: bytes(current, "config.json"),
			channels: bytes(current, "channels.json"),
			journal: bytes(current, "journals/acme-current/hook.jsonl"),
		};
		await assert.rejects(
			() => applyLegacyMigration({ home: current, expected_plan_hash: currentPlan.plan_hash }),
			(error) => error?.code === "migration.review_required",
			"weak/ambiguous evidence refuses before backup or canonical mutation",
		);
		assert.deepEqual(bytes(current, "config.json"), unsupportedBefore.config, "config remains byte-identical after review refusal");
		assert.deepEqual(bytes(current, "channels.json"), unsupportedBefore.channels, "channels remain byte-identical after review refusal");
		assert.deepEqual(bytes(current, "journals/acme-current/hook.jsonl"), unsupportedBefore.journal, "journals remain byte-identical after review refusal");
		assert.equal(existsSync(path.join(current, "canonical")), false, "review refusal creates no competing canonical state");
		assert.equal(existsSync(path.join(current, "migration-backups")), false, "review refusal occurs before backup creation");
		assert.equal(existsSync(path.join(current, "migration-status.json")), false, "review refusal occurs before status mutation");
		await assert.rejects(
			() => applyLegacyMigration({ home: malformed, expected_plan_hash: "0".repeat(64) }),
			(error) => error?.code === "migration.plan_hash_mismatch",
			"stale or forged plan hashes are rejected before mutation",
		);
		assert.equal(existsSync(path.join(malformed, "canonical")), false, "hash mismatch creates no canonical state");
		const locked = copyFixture("strong-only");
		try {
			const lockedPlan = await auditLegacyHome(locked);
			writeFileSync(path.join(locked, ".migration-apply.lock"), "another process\n", { mode: 0o600 });
			await assert.rejects(
				() => applyLegacyMigration({ home: locked, expected_plan_hash: lockedPlan.plan_hash }),
				(error) => error?.code === "migration.locked",
				"an active home migration lock refuses before backup or canonical writes",
			);
			assert.equal(existsSync(path.join(locked, "canonical")), false, "lock refusal exposes no half-authoritative canonical state");
		} finally {
			rmSync(locked, { recursive: true, force: true });
		}

		const crash = copyFixture("strong-only");
		try {
			const crashPlan = await auditLegacyHome(crash);
			await assert.rejects(
				() => applyLegacyMigration({ home: crash, expected_plan_hash: crashPlan.plan_hash, failpoint: "after_projection" }),
				(error) => error?.code === "migration.import_rejected",
				"checkpoint failure is surfaced rather than reported as applied",
			);
			assert.equal(existsSync(path.join(crash, "canonical")), false, "checkpoint failure restores the canonical backup");
			assert.equal(existsSync(path.join(crash, "compatibility")), false, "checkpoint failure removes generated compatibility output");
		} finally {
			rmSync(crash, { recursive: true, force: true });
		}
		runHostileTemporaryHomeProbe();
		return "real temporary homes prove exact-plan apply, strong aliases only, explicit unsupported-store review gates, immutable legacy bytes, canonical SQLite + generated read-only compatibility projection, hostile credential-path output redaction, and crash rollback";
	} finally {
		rmSync(strongOnly, { recursive: true, force: true });
		rmSync(old, { recursive: true, force: true });
		rmSync(current, { recursive: true, force: true });
		rmSync(malformed, { recursive: true, force: true });
	}
}
