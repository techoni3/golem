import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function copyFixture(name) {
	const home = mkdtempSync(path.join(os.tmpdir(), "golem-gol52-migration-"));
	cpSync(path.join(fixtures, name), home, { recursive: true });
	return home;
}

function bytes(home, relative) {
	return readFileSync(path.join(home, relative));
}

function migrationCli(home, args) {
	const result = spawnSync(process.execPath, [golemCli, "migrate", ...args, "--home", home, "--json"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `root golem migrate ${args.join(" ")} exits successfully: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

export async function runMigrationApplyReplay() {
	const old = copyFixture("old");
	const current = copyFixture("current");
	const malformed = copyFixture("malformed");
	try {
		const sourceBefore = bytes(old, "projects.json");
		const plan = migrationCli(old, ["plan"]);
		const applied = { status: migrationCli(old, ["apply", "--plan-hash", plan.plan_hash]) };
		assert.equal(applied.status.status, "applied", "strong legacy evidence imports only after the exact dry-run hash is rechecked");
		assert.deepEqual(applied.status.imported, { projects: 1, sessions: 1, generations: 1, aliases: 1 }, "one old representative project/session is materialized through canonical typed storage");
		assert.equal(Buffer.compare(sourceBefore, bytes(old, "projects.json")), 0, "apply leaves legacy source bytes untouched");
		assert.equal(existsSync(path.join(old, "canonical", "runtime.db")), true, "canonical SQLite target is populated separately from legacy inputs");
		const projection = JSON.parse(readFileSync(applied.status.compatibility_projection, "utf8"));
		assert.equal(projection.generated, true, "compatibility export is explicitly generated");
		assert.equal(projection.projects.length, 1, "projection is reproduced from canonical project state");
		assert.equal(projection.sessions.length, 1, "projection is reproduced from canonical session state");
		assert.equal(migrationCli(old, ["status"])?.plan_hash, plan.plan_hash, "status exposes the applied exact plan without opening legacy sources as writers");
		const rolledBack = migrationCli(old, ["rollback"]);
		assert.equal(rolledBack.status, "rolled_back", "rollback records an explicit durable state");
		assert.equal(existsSync(path.join(old, "canonical")), false, "rollback restores the pre-apply canonical pointer instead of reverse-inferencing legacy state");

		const currentPlan = await auditLegacyHome(current);
		await assert.rejects(
			() => applyLegacyMigration({ home: current, expected_plan_hash: currentPlan.plan_hash }),
			(error) => error?.code === "migration.review_required",
			"weak/ambiguous evidence refuses before backup or canonical mutation",
		);
		assert.equal(existsSync(path.join(current, "canonical")), false, "review refusal creates no competing canonical state");
		await assert.rejects(
			() => applyLegacyMigration({ home: malformed, expected_plan_hash: "0".repeat(64) }),
			(error) => error?.code === "migration.plan_hash_mismatch",
			"stale or forged plan hashes are rejected before mutation",
		);
		assert.equal(existsSync(path.join(malformed, "canonical")), false, "hash mismatch creates no canonical state");
		const locked = copyFixture("old");
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

		const crash = copyFixture("old");
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
		return "real temporary homes prove exact-plan apply, strong aliases only, immutable legacy bytes, canonical SQLite + generated read-only compatibility projection, and crash rollback";
	} finally {
		rmSync(old, { recursive: true, force: true });
		rmSync(current, { recursive: true, force: true });
		rmSync(malformed, { recursive: true, force: true });
	}
}
