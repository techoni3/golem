import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditLegacyHome, stableAuditPlanJson } from "@golem/compat";
import { redactAuditValue } from "../../packages/compat/dist/redact/redact.js";

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

function createTrackerDb(file, userVersion = 0) {
	const db = new Database(file);
	try {
		db.exec("create table migration_fixture (id text primary key, note text); insert into migration_fixture values ('one', 'real sqlite metadata');");
		db.pragma(`user_version = ${userVersion}`);
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
	createTrackerDb(path.join(root, "current", "tracker.db"), 17);
}

function fingerprintFile(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sourceFor(plan, id) {
	const found = plan.sources.find((source) => source.id === id);
	assert(found, `expected ${id} source`);
	return found;
}

async function raceReplacement(home, target, variants, sourceId) {
	let index = 0;
	const timer = setInterval(() => {
		const temporary = path.join(path.dirname(target), `.audit-race-${index}`);
		writeFileSync(temporary, variants[index % variants.length]);
		renameSync(temporary, target);
		index += 1;
	}, 1);
	try {
		for (let attempt = 0; attempt < 80; attempt += 1) {
			const plan = await auditLegacyHome(home);
			const changed = sourceFor(plan, sourceId);
			if (changed.status === "changed") return plan;
		}
	} finally {
		clearInterval(timer);
	}
	assert.fail(`atomic replacement must produce ${sourceId} changed-during-audit evidence`);
}

async function assertStableObjectSnapshots(root) {
	const home = path.join(root, "stable-snapshot");
	mkdirSync(home);
	const projects = path.join(home, "projects.json");
	writeFileSync(projects, '{"projects":[]}\n');
	const tracker = path.join(home, "tracker.db");
	createTrackerDb(tracker, 23);
	const plan = await auditLegacyHome(home);
	const projectSource = sourceFor(plan, "projects");
	assert.equal(projectSource.fingerprint, fingerprintFile(projects), "stable JSON fingerprint must describe the opened bytes");
	assert.equal(projectSource.size_bytes, lstatSync(projects).size, "stable JSON metadata must describe the opened object");
	const trackerSource = sourceFor(plan, "tracker");
	assert.equal(trackerSource.fingerprint, fingerprintFile(tracker), "SQLite fingerprint must describe the same opened bytes as its header");
	assert.equal(trackerSource.details?.user_version, 23, "SQLite header fields must be read from the fingerprinted descriptor");

	const jsonRace = path.join(root, "json-race");
	cpSync(home, jsonRace, { recursive: true });
	const jsonTarget = path.join(jsonRace, "projects.json");
	const jsonPlan = await raceReplacement(
		jsonRace,
		jsonTarget,
		[
			Buffer.from(`{"projects":[],"padding":"${"a".repeat(900_000)}"}\n`),
			Buffer.from(`{"projects":[],"padding":"${"b".repeat(900_000)}"}\n`),
		],
		"projects",
	);
	const changedJson = sourceFor(jsonPlan, "projects");
	assert.equal(changedJson.status, "changed", "JSON replacement must quarantine a changed descriptor rather than mix metadata and content");
	assert.equal(changedJson.fingerprint, undefined, "changed JSON must not publish a blended fingerprint");

	const sqliteRace = path.join(root, "sqlite-race");
	cpSync(home, sqliteRace, { recursive: true });
	const sqliteTarget = path.join(sqliteRace, "tracker.db");
	const sqliteA = path.join(root, "sqlite-a.db");
	const sqliteB = path.join(root, "sqlite-b.db");
	createTrackerDb(sqliteA, 31);
	createTrackerDb(sqliteB, 47);
	const sqlitePlan = await raceReplacement(
		sqliteRace,
		sqliteTarget,
		[readFileSync(sqliteA), readFileSync(sqliteB)],
		"tracker",
	);
	const changedSqlite = sourceFor(sqlitePlan, "tracker");
	assert.equal(changedSqlite.status, "changed", "SQLite replacement must report changed-during-audit rather than cross-read header metadata");
	assert.equal(changedSqlite.fingerprint, undefined, "changed SQLite must not publish an unrelated fingerprint");
	assert.equal(changedSqlite.details, undefined, "changed SQLite must not publish a header from another replacement");
}

async function assertPathContainmentAndInventory(root) {
	const outside = path.join(root, "outside");
	mkdirSync(outside);
	writeFileSync(path.join(outside, "outside-proof.txt"), "outside-proof-must-not-appear");
	const swappedHome = path.join(root, "intermediate-swap");
	const journals = path.join(swappedHome, "journals");
	mkdirSync(journals, { recursive: true });
	for (let index = 0; index < 2_500; index += 1)
		writeFileSync(path.join(journals, `a-${String(index).padStart(4, "0")}.jsonl`), "safe");
	const swapTarget = path.join(journals, "zzz");
	mkdirSync(swapTarget);
	writeFileSync(path.join(swapTarget, "inside.jsonl"), "inside");
	const parked = path.join(journals, "zzz-before-swap");
	let swapped = false;
	const timer = setTimeout(() => {
		renameSync(swapTarget, parked);
		symlinkSync(outside, swapTarget, "dir");
		swapped = true;
	}, 20);
	let swappedPlan;
	try {
		swappedPlan = await auditLegacyHome(swappedHome);
	} finally {
		clearTimeout(timer);
	}
	assert(swapped, "the intermediate directory must be swapped during recursive inventory");
	assert(swappedPlan.findings.some((entry) => entry.code === "audit.source.symlink" || entry.code === "audit.source.path_escape"), "an intermediate symlink swap must be contained and reported");
	assert.equal(stableAuditPlanJson(swappedPlan).includes("outside-proof-must-not-appear"), false, "intermediate swaps must never inventory outside bytes");
	assert.equal(sourceFor(swappedPlan, "journals").status, "unsafe", "the recursively swapped root must not remain trusted");

	const credentialHome = path.join(root, "credential-path");
	const credentialSegment = "ghp-abcdef1234567890";
	mkdirSync(path.join(credentialHome, "journals", credentialSegment), { recursive: true });
	writeFileSync(path.join(credentialHome, "journals", credentialSegment, "hook.jsonl"), "safe");
	const credentialPlan = await auditLegacyHome(credentialHome);
	const credentialOutput = stableAuditPlanJson(credentialPlan);
	assert.equal(credentialOutput.includes(credentialSegment), false, "credential-shaped pathname components must be redacted everywhere, including source ids");
	assert.match(credentialOutput, /\$REDACTED_[0-9a-f]{16}/u, "credential-shaped pathname components must retain a stable opaque alias");
	assert.equal(redactAuditValue("ghp-abcdef1234567890"), "$REDACTED", "first credential value must redact");
	assert.equal(redactAuditValue("ghp-abcdef1234567890"), "$REDACTED", "repeated credential value must redact without RegExp state");

	const cappedHome = path.join(root, "global-inventory-cap");
	for (const directory of ["journals", "spool"]) {
		const target = path.join(cappedHome, directory);
		mkdirSync(target, { recursive: true });
		for (let index = 0; index < 5_001; index += 1)
			writeFileSync(path.join(target, `${String(index).padStart(5, "0")}.jsonl`), "bounded");
	}
	const cappedPlan = await auditLegacyHome(cappedHome);
	const inventoried = cappedPlan.sources.filter((source) => /^(?:journals|spool)\//u.test(source.id));
	assert(inventoried.length <= 5_000, "all recursive source roots must share one deterministic 5,000-entry inventory budget");
	assert.equal(cappedPlan.findings.filter((entry) => entry.code === "audit.source.entry_limit").length, 1, "the global cap must produce one deterministic quarantine finding");
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
		for (const source of ["config", "channels", "journals"]) {
			assert(
				hasAction(currentFirst, "review", `compat.${source}.typed_importer_required`),
				`present ${source} source must remain an explicit typed-importer review gate`,
			);
		}
		assert.equal(stableAuditPlanJson(currentFirst).includes("fixture-secret-must-not-appear"), false, "config secret values must not appear in plan JSON");
		assert.equal(stableAuditPlanJson(currentFirst).includes("channel-secret-value"), false, "state secret values must not appear in plan JSON");
		assert(currentFirst.sources.some((source) => source.id === "tracker" && source.status === "present" && source.fingerprint && source.details?.format === "sqlite"), "real SQLite metadata must be fingerprinted and header-inspected without opening a writable database");
		assert(
			hasAction(currentFirst, "attach", "compat.tracker.retained_authority"),
			"the independently authoritative tracker database is checkpointed and attached rather than sent through a nonexistent runtime importer",
		);

		const oldPlan = await auditLegacyHome(old);
		const relocated = oldPlan.actions.find((entry) => entry.kind === "attach" && entry.reason === "compat.project.strong_registration");
		assert(relocated, "relocated project with a strong UUID remains one attach proposal");
		assert.equal(relocated.facts.location_aliases, 2, "strong UUID relocation must retain both old and new roots as aliases");
		assert.equal(relocated.affected_ids.filter((id) => id.startsWith("location:")).length, 2, "strong UUID relocation must not select one path by receipt order");

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
		await assertStableObjectSnapshots(root);
		await assertPathContainmentAndInventory(root);
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
		return "current/old/malformed real homes keep source bytes and SQLite metadata unchanged while a single descriptor snapshot, containment fence, global inventory cap, redaction, and strong relocation aliases keep deterministic plans safe";
	} finally {
		const unreadable = path.join(root, "malformed", "endpoint-leases.json");
		if (existsSync(unreadable)) chmodSync(unreadable, 0o600);
		rmSync(root, { recursive: true, force: true });
	}
}
