import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditLegacyHome, stableAuditPlanJson } from "@golem/compat";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(repositoryRoot, "test/fixtures/migration");

function fingerprintTree(root) {
	const rows = [];
	const scan = (absolute, relative = ".") => {
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) {
			rows.push([relative, "symlink"]);
			return;
		}
		if (stat.isDirectory()) {
			rows.push([relative, "directory", stat.mode, stat.mtimeMs]);
			for (const entry of readdirSync(absolute).sort()) scan(path.join(absolute, entry), path.join(relative, entry));
			return;
		}
		let contents = "$UNREADABLE";
		try {
			contents = readFileSync(absolute, "utf8");
		} catch (error) {
			assert.equal(error?.code, "EACCES", "only the deliberate permission fixture may be unreadable");
		}
		rows.push([relative, "file", stat.mode, stat.mtimeMs, contents]);
	};
	scan(root);
	return JSON.stringify(rows);
}

function createTrackerDb(home) {
	const db = new Database(path.join(home, "tracker.db"));
	try {
		db.exec("create table migration_fixture (id text primary key, note text); insert into migration_fixture values ('one', 'real sqlite metadata');");
	} finally {
		db.close();
	}
}

function copyCorpus(root) {
	for (const name of ["current", "old", "malformed"])
		cpSync(path.join(fixtureRoot, name), path.join(root, name), { recursive: true });
	const malformed = path.join(root, "malformed");
	symlinkSync(path.join("..", "current", "channels.json"), path.join(malformed, "channels.json"));
	writeFileSync(path.join(malformed, "endpoint-leases.json"), "{}\n");
	chmodSync(path.join(malformed, "endpoint-leases.json"), 0o000);
	createTrackerDb(path.join(root, "current"));
}

function hasAction(plan, kind, reason) {
	return plan.actions.some((entry) => entry.kind === kind && entry.reason === reason);
}

export async function runMigrationPlanReplay() {
	const root = mkdtempSync(path.join(os.tmpdir(), "golem-j7-migration-"));
	try {
		copyCorpus(root);
		const current = path.join(root, "current");
		const old = path.join(root, "old");
		const malformed = path.join(root, "malformed");
		const before = [fingerprintTree(current), fingerprintTree(old), fingerprintTree(malformed)];
		const currentFirst = await auditLegacyHome(current);
		const currentSecond = await auditLegacyHome(current);
		assert.equal(stableAuditPlanJson(currentFirst), stableAuditPlanJson(currentSecond), "identical sources must yield byte-identical redacted plan JSON");
		assert.equal(currentFirst.plan_hash, currentSecond.plan_hash, "identical sources must retain the exact plan hash");
		assert(hasAction(currentFirst, "attach", "compat.project.strong_registration"), "worktree and main project locations must attach through strong registration evidence");
		assert(hasAction(currentFirst, "attach", "compat.session.strong_alias"), "strong project/session/harness evidence must attach");
		assert(hasAction(currentFirst, "retire", "compat.session.terminal_history"), "terminal evidence must remain history, not a live auto-merge");
		assert(hasAction(currentFirst, "review", "compat.session.weak_evidence"), "name/PID-only evidence must remain review-only");
		assert(hasAction(currentFirst, "ignore", "compat.config.unknown_keys_preserved"), "unknown config regions must remain preserved for a later managed merge");
		assert.equal(stableAuditPlanJson(currentFirst).includes("fixture-secret-must-not-appear"), false, "config secret values must not appear in plan JSON");
		assert.equal(stableAuditPlanJson(currentFirst).includes("channel-secret-value"), false, "state secret values must not appear in plan JSON");
		assert(currentFirst.sources.some((source) => source.id === "tracker" && source.status === "present" && source.fingerprint && source.details?.format === "sqlite"), "real SQLite metadata must be fingerprinted and header-inspected without opening a writable database");

		const oldPlan = await auditLegacyHome(old);
		assert(hasAction(oldPlan, "attach", "compat.project.strong_registration"), "relocated project with explicit id/path remains one UUID proposal");

		const malformedPlan = await auditLegacyHome(malformed);
		assert(hasAction(malformedPlan, "quarantine", "audit.source.malformed"), "truncated JSON must quarantine without aborting the corpus");
		assert(hasAction(malformedPlan, "quarantine", "audit.source.unreadable"), "permission-denied input must be isolated as a finding");
		assert(malformedPlan.findings.some((entry) => entry.code === "audit.source.symlink"), "unsafe links must be reported and never followed");
		assert(hasAction(malformedPlan, "review", "compat.project.weak_or_unsafe"), "broad project roots must not become canonical projects");
		assert(hasAction(malformedPlan, "review", "compat.project.ambiguous_location"), "conflicting location evidence must remain review-only with no selected owner");
		assert(hasAction(malformedPlan, "attach", "compat.project.strong_registration"), "a valid source beside malformed input must still be inventoried");
		assert.equal(stableAuditPlanJson(malformedPlan).includes("do-not-print-this-value"), false, "malformed-home config secrets must remain redacted");

		const changed = path.join(root, "changed");
		cpSync(current, changed, { recursive: true });
		writeFileSync(path.join(changed, "projects.json"), `${readFileSync(path.join(changed, "projects.json"), "utf8").replace("Acme feature", "Acme changed")}\n`);
		const changedPlan = await auditLegacyHome(changed);
		assert.notEqual(changedPlan.plan_hash, currentFirst.plan_hash, "a source-byte change must invalidate the plan hash");
		const versionChanged = await auditLegacyHome(current, { planner_version: "golem.compat.audit/v2" });
		assert.notEqual(versionChanged.plan_hash, currentFirst.plan_hash, "a planner-version change must invalidate the plan hash");
		const applyAttempt = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "packages/compat/bin/migration-plan.mjs"),
				"--home",
				current,
				"--apply",
			],
			{ cwd: repositoryRoot, encoding: "utf8" },
		);
		assert.equal(applyAttempt.status, 2, "the temporary audit command must reject apply instead of mutating a home");
		assert.match(applyAttempt.stderr, /read-only/u);
		assert.deepEqual([fingerprintTree(current), fingerprintTree(old), fingerprintTree(malformed)], before, "audit must not mutate any supplied fixture source, SQLite metadata, mtimes, or permissions");
		assert.equal(existsSync(path.join(current, "runtime.db")), false, "dry-run must not create canonical runtime state");
		return "current/old/malformed real homes keep source bytes and SQLite metadata unchanged while deterministic redacted plans attach only strong evidence and quarantine unsafe input";
	} finally {
		const unreadable = path.join(root, "malformed", "endpoint-leases.json");
		if (existsSync(unreadable)) chmodSync(unreadable, 0o600);
		rmSync(root, { recursive: true, force: true });
	}
}
