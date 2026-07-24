import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	persistenceMigrations,
	readControlPlaneAuthority,
	writeControlPlaneAuthority,
} from "@golem/persistence";

import { migrationStatus } from "../apply/service.js";
import type { MigrationStatus } from "../apply/types.js";
import { auditLegacyHome } from "../audit/audit.js";
import type { AuditPlan } from "../plan/types.js";
import type {
	ApplyCanonicalCutoverOptions,
	ApplyCanonicalCutoverResult,
	CanonicalCutoverPhase,
	CanonicalCutoverPlan,
	CanonicalCutoverState,
	CutoverGate,
	CutoverGateCode,
	CutoverPreflightEvidence,
	CutoverSoakEvidence,
	CutoverSoakResult,
	PlanCanonicalCutoverOptions,
} from "./types.js";
import { CanonicalCutoverError } from "./types.js";

const stateFilename = "cutover-state.json";
const lockFilename = ".cutover.lock";

interface CompatibilityProjection {
	readonly schema_version: "golem.compatibility-projection/v1";
	readonly canonical_revision: number;
	readonly projects: readonly unknown[];
	readonly sessions: readonly unknown[];
	readonly [key: string]: unknown;
}

function now(options: { readonly now?: () => string }): string {
	return options.now?.() ?? new Date().toISOString();
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonical(child)]),
		);
	return value;
}

function digest(value: unknown): string {
	const bytes =
		typeof value === "string" || value instanceof Uint8Array
			? value
			: JSON.stringify(canonical(value));
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileDigest(target: string): string {
	const hash = crypto.createHash("sha256");
	const descriptor = fs.openSync(target, "r");
	try {
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (count === 0) break;
			hash.update(buffer.subarray(0, count));
		}
		return hash.digest("hex");
	} finally {
		fs.closeSync(descriptor);
	}
}

function defaultServiceBinaryPath(): string {
	const candidate = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../../../apps/control-plane/dist/main.js",
	);
	return fs.existsSync(candidate) ? candidate : process.execPath;
}

function atomicJson(target: string, body: unknown, mode = 0o600): void {
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, {
			encoding: "utf8",
			mode,
			flag: "wx",
		});
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function statePath(home: string): string {
	return path.join(home, "control-plane", stateFilename);
}

function readJson(target: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(target, "utf8"));
	} catch {
		return undefined;
	}
}

function readProjection(home: string): CompatibilityProjection | undefined {
	const value = readJson(
		path.join(home, "compatibility", "legacy-projection.json"),
	);
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const candidate = value as Partial<CompatibilityProjection>;
	return candidate.schema_version === "golem.compatibility-projection/v1" &&
		Number.isInteger(candidate.canonical_revision) &&
		Array.isArray(candidate.projects) &&
		Array.isArray(candidate.sessions)
		? (value as CompatibilityProjection)
		: undefined;
}

function validState(value: unknown): value is CanonicalCutoverState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<CanonicalCutoverState>;
	return (
		candidate.schema_version === "golem.canonical-cutover-state/v1" &&
		typeof candidate.plan_hash === "string" &&
		/^[a-f0-9]{64}$/u.test(candidate.plan_hash) &&
		[
			"quiesced",
			"checkpointed",
			"soaking",
			"stable",
			"rollback_required",
			"rolled_back",
		].includes(candidate.phase ?? "") &&
		Number.isInteger(candidate.canonical_revision) &&
		Number.isInteger(candidate.authority_revision) &&
		typeof candidate.updated_at === "string" &&
		Array.isArray(candidate.transitions)
	);
}

export function canonicalCutoverStatus(
	home: string,
): CanonicalCutoverState | undefined {
	const value = readJson(statePath(home));
	if (value === undefined) return undefined;
	if (!validState(value))
		throw new CanonicalCutoverError(
			"cutover.state_invalid",
			"canonical cutover state is invalid; restore the authority pointer from its checkpoint",
		);
	return Object.freeze(value);
}

function transition(
	home: string,
	input: {
		readonly planHash: string;
		readonly phase: CanonicalCutoverPhase;
		readonly canonicalRevision: number;
		readonly authorityRevision: number;
		readonly checkpointManifest?: string;
		readonly rollbackAudit?: string;
		readonly reason?: string;
		readonly at: string;
	},
): CanonicalCutoverState {
	const current = canonicalCutoverStatus(home);
	const transitions = [
		...(current?.transitions ?? []),
		{
			phase: input.phase,
			at: input.at,
			...(input.reason ? { reason: input.reason } : {}),
		},
	];
	const state: CanonicalCutoverState = Object.freeze({
		schema_version: "golem.canonical-cutover-state/v1",
		plan_hash: input.planHash,
		phase: input.phase,
		canonical_revision: input.canonicalRevision,
		authority_revision: input.authorityRevision,
		...(input.checkpointManifest
			? { checkpoint_manifest: input.checkpointManifest }
			: current?.checkpoint_manifest
				? { checkpoint_manifest: current.checkpoint_manifest }
				: {}),
		...(input.rollbackAudit ? { rollback_audit: input.rollbackAudit } : {}),
		updated_at: input.at,
		transitions: Object.freeze(transitions),
	});
	atomicJson(statePath(home), state);
	return state;
}

function acquireLock(home: string): () => void {
	const target = path.join(home, "control-plane", lockFilename);
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			fs.writeFileSync(
				target,
				`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
				{ encoding: "utf8", flag: "wx", mode: 0o600 },
			);
			return () => fs.rmSync(target, { force: true });
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "EEXIST"
			)
				throw error;
			const existing = readJson(target);
			const pid =
				existing && typeof existing === "object"
					? (existing as Record<string, unknown>).pid
					: undefined;
			let alive = !Number.isInteger(pid) || Number(pid) <= 0;
			if (!alive) {
				try {
					process.kill(Number(pid), 0);
					alive = true;
				} catch (probeError) {
					alive =
						typeof probeError === "object" &&
						probeError !== null &&
						"code" in probeError &&
						probeError.code === "EPERM";
				}
			}
			if (alive || attempt > 0)
				throw new CanonicalCutoverError(
					"cutover.locked",
					"another canonical cutover operation owns this home",
				);
			// A process crash must not make the state machine permanently
			// unavailable. Only a syntactically valid, definitely dead PID is
			// recoverable; malformed locks remain fail-closed.
			fs.rmSync(target, { force: true });
		}
	}
	throw new CanonicalCutoverError(
		"cutover.locked",
		"another canonical cutover operation owns this home",
	);
}

function gate(
	code: CutoverGateCode,
	passed: boolean,
	actual: string | number | boolean,
	remedy: string,
): CutoverGate {
	return Object.freeze({ code, passed, actual, remedy });
}

function backupManifestPath(home: string, migration: MigrationStatus): string {
	return path.join(
		home,
		"migration-backups",
		migration.plan_hash.slice(0, 24),
		"manifest.json",
	);
}

function availableBytes(home: string): number {
	try {
		const stat = fs.statfsSync(home);
		return Number(stat.bavail) * Number(stat.bsize);
	} catch {
		return 0;
	}
}

function activeServiceOwners(home: string): number {
	const owners = new Set<number>();
	for (const target of [
		path.join(home, "dashboard.json"),
		path.join(home, "control-plane", "control-plane.lock"),
	]) {
		const value = readJson(target);
		if (!value || typeof value !== "object") continue;
		const pid = (value as Record<string, unknown>).pid;
		if (!Number.isInteger(pid) || Number(pid) <= 0) continue;
		try {
			process.kill(Number(pid), 0);
			owners.add(Number(pid));
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "EPERM"
			)
				owners.add(Number(pid));
		}
	}
	return owners.size;
}

function planHashBody(
	plan: Omit<CanonicalCutoverPlan, "plan_hash" | "generated_at">,
): string {
	return digest(plan);
}

const retiredRuntimeSourceIds = new Set([
	"projects",
	"sessions",
	"facts",
	"leases",
	"channels",
	"opencode-bridges",
	"codex-supervisors",
]);

function runtimeSourceHash(plan: AuditPlan): string {
	return digest(
		plan.sources.filter((source) => retiredRuntimeSourceIds.has(source.id)),
	);
}

export async function planCanonicalCutover(
	options: PlanCanonicalCutoverOptions,
): Promise<CanonicalCutoverPlan> {
	const home = path.resolve(options.home);
	const evidence: CutoverPreflightEvidence = options.evidence ?? {};
	const migration = await migrationStatus(home);
	const currentLegacyPlan = await auditLegacyHome(home);
	const projection = readProjection(home);
	const binaryPath = path.resolve(
		options.binary_path ?? defaultServiceBinaryPath(),
	);
	const binaryHash = fs.existsSync(binaryPath) ? fileDigest(binaryPath) : "";
	const schemaHash = digest(persistenceMigrations);
	const migrationHash = migration
		? digest({
				plan_hash: migration.plan_hash,
				source_manifest_hash: migration.source_manifest_hash,
				imported: migration.imported,
			})
		: "";
	const backupPath = migration ? backupManifestPath(home, migration) : "";
	const backup = backupPath ? readJson(backupPath) : undefined;
	const backupSnapshotHome = backupPath
		? path.join(path.dirname(backupPath), "legacy")
		: "";
	const importedLegacyPlan =
		backupSnapshotHome && fs.existsSync(backupSnapshotHome)
			? await auditLegacyHome(backupSnapshotHome)
			: undefined;
	const importedRuntimeSourceHash = importedLegacyPlan
		? runtimeSourceHash(importedLegacyPlan)
		: "";
	const currentRuntimeSourceHash = runtimeSourceHash(currentLegacyPlan);
	const backupVerified =
		Boolean(backup) &&
		typeof backup === "object" &&
		(backup as Record<string, unknown>).plan_hash === migration?.plan_hash;
	const parityGaps = evidence.parity_gaps ?? [];
	const unsafeBacklog = evidence.unsafe_backlog ?? 0;
	const serviceOwners = evidence.service_owners ?? activeServiceOwners(home);
	const unqualifiedPresets = (evidence.presets ?? []).filter(
		(preset) => preset.enabled && !preset.qualified,
	);
	const apiSmoke = evidence.api_smoke ?? true;
	const uiSmoke = evidence.ui_smoke ?? true;
	const strongConflicts = evidence.strong_identity_conflicts ?? 0;
	const minimumFreeBytes =
		evidence.minimum_free_bytes ??
		Math.max(1_048_576, (migration?.source_bytes ?? 0) * 2);
	const freeBytes = availableBytes(home);
	const canonicalInvariant =
		Boolean(projection) &&
		Boolean(migration) &&
		projection?.projects.length === migration?.imported.projects &&
		projection?.sessions.length === migration?.imported.sessions &&
		fs.existsSync(path.join(home, "canonical", "runtime.db")) &&
		fs.existsSync(path.join(home, "tracker.db"));
	const gates: readonly CutoverGate[] = Object.freeze([
		gate(
			"cutover.migration_applied",
			migration?.status === "applied",
			migration?.status ?? "missing",
			"run the exact-hash legacy migration apply before cutover",
		),
		gate(
			"cutover.backup_verified",
			backupVerified,
			backupVerified,
			"re-run migration apply so its exact backup manifest can be verified",
		),
		gate(
			"cutover.binary_hash",
			binaryHash.length === 64 &&
				(!evidence.expected_binary_hash ||
					evidence.expected_binary_hash === binaryHash),
			binaryHash || "missing",
			"stage the expected service binary and regenerate the cutover plan",
		),
		gate(
			"cutover.schema_hash",
			!evidence.expected_schema_hash ||
				evidence.expected_schema_hash === schemaHash,
			schemaHash,
			"build the expected persistence schema before retrying cutover",
		),
		gate(
			"cutover.migration_hash",
			Boolean(migrationHash) &&
				(!evidence.expected_migration_hash ||
					evidence.expected_migration_hash === migrationHash),
			migrationHash || "missing",
			"repeat migration dry-run/apply and approve its exact artifact hash",
		),
		gate(
			"cutover.final_import_current",
			Boolean(migration) &&
				Boolean(importedRuntimeSourceHash) &&
				currentRuntimeSourceHash === importedRuntimeSourceHash,
			Boolean(migration) &&
				Boolean(importedRuntimeSourceHash) &&
				currentRuntimeSourceHash === importedRuntimeSourceHash,
			"legacy sources changed after import; roll back the staged migration, re-import the final exact snapshot, then regenerate the cutover plan",
		),
		gate(
			"cutover.parity_complete",
			parityGaps.length === 0,
			parityGaps.length,
			"close every required parity gap before C4",
		),
		gate(
			"cutover.backlog_safe",
			unsafeBacklog === 0,
			unsafeBacklog,
			"drain or explicitly quarantine every unsafe inbox/outbox item",
		),
		gate(
			"cutover.single_owner",
			serviceOwners <= 1,
			serviceOwners <= 1,
			"fence duplicate services until at most one owner remains; apply quiesces that final owner",
		),
		gate(
			"cutover.presets_qualified",
			unqualifiedPresets.length === 0,
			unqualifiedPresets.length,
			"disable or qualify each enabled launcher preset",
		),
		gate(
			"cutover.api_smoke",
			apiSmoke,
			apiSmoke,
			"pass the authenticated typed API smoke before C4",
		),
		gate(
			"cutover.ui_smoke",
			uiSmoke,
			uiSmoke,
			"pass the typed dashboard smoke before C4",
		),
		gate(
			"cutover.disk_space",
			Number.isSafeInteger(freeBytes) && freeBytes >= minimumFreeBytes,
			Number.isSafeInteger(freeBytes) && freeBytes >= minimumFreeBytes,
			`free at least ${minimumFreeBytes} bytes for checkpoints`,
		),
		gate(
			"cutover.identity_conflicts",
			strongConflicts === 0,
			strongConflicts,
			"resolve every strong-identity conflict or leave it explicitly quarantined",
		),
		gate(
			"cutover.canonical_invariants",
			canonicalInvariant,
			canonicalInvariant,
			"re-run migration and verify canonical counts/revision plus tracker authority",
		),
	]);
	const body = Object.freeze({
		schema_version: "golem.canonical-cutover-plan/v1" as const,
		migration_plan_hash: migration?.plan_hash ?? "0".repeat(64),
		source_manifest_hash: migration?.source_manifest_hash ?? "0".repeat(64),
		imported_runtime_source_hash: importedRuntimeSourceHash || "0".repeat(64),
		current_runtime_source_hash: currentRuntimeSourceHash,
		binary_hash: binaryHash || "0".repeat(64),
		schema_hash: schemaHash,
		migration_hash: migrationHash || "0".repeat(64),
		canonical_revision: projection?.canonical_revision ?? 0,
		canonical_counts: Object.freeze({
			projects: projection?.projects.length ?? 0,
			sessions: projection?.sessions.length ?? 0,
		}),
		gates,
		eligible: gates.every((entry) => entry.passed),
	});
	return Object.freeze({
		...body,
		plan_hash: planHashBody(body),
		generated_at: now(options),
	});
}

function copyIfPresent(source: string, target: string): void {
	if (!fs.existsSync(source)) return;
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	fs.cpSync(source, target, {
		dereference: false,
		preserveTimestamps: true,
		recursive: true,
	});
}

function createCheckpoint(home: string, plan: CanonicalCutoverPlan): string {
	const directory = path.join(
		home,
		"cutover-backups",
		plan.plan_hash.slice(0, 24),
	);
	const manifestPath = path.join(directory, "manifest.json");
	if (fs.existsSync(manifestPath)) {
		const existing = readJson(manifestPath);
		if (
			existing &&
			typeof existing === "object" &&
			(existing as Record<string, unknown>).plan_hash === plan.plan_hash
		)
			return path.relative(home, manifestPath);
		throw new CanonicalCutoverError(
			"cutover.state_invalid",
			"cutover checkpoint exists but does not match the approved plan",
		);
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const relative of [
		"runtime.db",
		"runtime.db-wal",
		"runtime.db-shm",
		"tracker.db",
		"tracker.db-wal",
		"tracker.db-shm",
		"config.json",
		"config.jsonc",
		"dashboard.json",
		"substrate.lock",
		"renders",
		"control-plane/service-definition.json",
	])
		copyIfPresent(
			path.join(home, relative),
			path.join(directory, "legacy", relative),
		);
	copyIfPresent(
		path.join(home, "canonical"),
		path.join(directory, "canonical"),
	);
	const manifest = {
		schema_version: "golem.canonical-cutover-checkpoint/v1",
		plan_hash: plan.plan_hash,
		binary_hash: plan.binary_hash,
		schema_hash: plan.schema_hash,
		migration_hash: plan.migration_hash,
		runtime_authority: "canonical/runtime.db",
		tracker_authority: "tracker.db",
	};
	atomicJson(manifestPath, manifest);
	return path.relative(home, manifestPath);
}

function publishCompatibilityProjection(
	home: string,
	plan: CanonicalCutoverPlan,
): void {
	const target = path.join(home, "compatibility", "legacy-projection.json");
	const projection = readProjection(home);
	if (!projection)
		throw new CanonicalCutoverError(
			"cutover.state_invalid",
			"generated compatibility projection is unavailable",
		);
	atomicJson(
		target,
		{
			...projection,
			generated: true,
			authoritative: false,
			read_only: true,
			authority: "canonical",
			canonical_revision: plan.canonical_revision,
			cutover_plan_hash: plan.plan_hash,
			banner:
				"generated/non-authoritative compatibility export; writes are rejected",
		},
		0o444,
	);
	fs.chmodSync(target, 0o444);
}

function assertApproved(plan: CanonicalCutoverPlan, expected: string): void {
	if (!expected.trim())
		throw new CanonicalCutoverError(
			"cutover.plan_hash_required",
			"an explicit canonical cutover plan hash is required",
		);
	if (plan.plan_hash !== expected)
		throw new CanonicalCutoverError(
			"cutover.plan_hash_mismatch",
			"the supplied hash does not match the current canonical cutover plan",
		);
	const failed = plan.gates.filter((entry) => !entry.passed);
	if (failed.length)
		throw new CanonicalCutoverError(
			"cutover.preflight_failed",
			failed.map((entry) => `${entry.code}: ${entry.remedy}`).join("; "),
			failed,
		);
}

export async function applyCanonicalCutover(
	options: ApplyCanonicalCutoverOptions,
): Promise<ApplyCanonicalCutoverResult> {
	const plan = await planCanonicalCutover(options);
	assertApproved(plan, options.expected_plan_hash);
	const release = acquireLock(options.home);
	try {
		const before = canonicalCutoverStatus(options.home);
		let authority = readControlPlaneAuthority(options.home);
		if (
			authority.stage === "C4" &&
			authority.plan_hash === plan.plan_hash &&
			before &&
			(before.phase === "soaking" || before.phase === "stable")
		)
			return Object.freeze({
				plan,
				state: before,
				authority,
				resumed: false,
				idempotent: true,
			});
		const resumed =
			authority.write_policy === "quiesced" ||
			before?.phase === "quiesced" ||
			before?.phase === "checkpointed";
		if (authority.stage === "C3" && authority.write_policy === "legacy_open") {
			authority = writeControlPlaneAuthority(options.home, {
				stage: "C3",
				write_policy: "quiesced",
				plan_hash: plan.plan_hash,
				canonical_revision: plan.canonical_revision,
				updated_at: now(options),
			});
			transition(options.home, {
				planHash: plan.plan_hash,
				phase: "quiesced",
				canonicalRevision: plan.canonical_revision,
				authorityRevision: authority.revision,
				at: now(options),
			});
		} else if (
			authority.stage !== "C3" ||
			authority.write_policy !== "quiesced" ||
			authority.plan_hash !== plan.plan_hash
		) {
			throw new CanonicalCutoverError(
				"cutover.state_invalid",
				"authority pointer is not a resumable C3 quiesce for this plan",
			);
		}
		if (options.failpoint === "after_quiesce")
			throw new Error("canonical cutover failpoint after_quiesce");
		const finalLegacyPlan = await auditLegacyHome(options.home);
		if (
			runtimeSourceHash(finalLegacyPlan) !== plan.current_runtime_source_hash ||
			runtimeSourceHash(finalLegacyPlan) !== plan.imported_runtime_source_hash
		)
			throw new CanonicalCutoverError(
				"cutover.source_changed",
				"legacy sources changed after the exact cutover plan was approved; writers remain quiesced until rollback or a fresh final import",
			);
		const checkpointManifest = createCheckpoint(options.home, plan);
		const checkpointed = transition(options.home, {
			planHash: plan.plan_hash,
			phase: "checkpointed",
			canonicalRevision: plan.canonical_revision,
			authorityRevision: authority.revision,
			checkpointManifest,
			at: now(options),
		});
		if (options.failpoint === "after_checkpoint")
			throw new Error("canonical cutover failpoint after_checkpoint");
		publishCompatibilityProjection(options.home, plan);
		authority = writeControlPlaneAuthority(options.home, {
			stage: "C4",
			write_policy: "canonical_only",
			plan_hash: plan.plan_hash,
			canonical_revision: plan.canonical_revision,
			updated_at: now(options),
		});
		const state = transition(options.home, {
			planHash: plan.plan_hash,
			phase: "soaking",
			canonicalRevision: plan.canonical_revision,
			authorityRevision: authority.revision,
			...(checkpointed.checkpoint_manifest
				? { checkpointManifest: checkpointed.checkpoint_manifest }
				: {}),
			at: now(options),
		});
		if (options.failpoint === "after_switch")
			throw new Error("canonical cutover failpoint after_switch");
		return Object.freeze({
			plan,
			state,
			authority,
			resumed,
			idempotent: false,
		});
	} finally {
		release();
	}
}

function auditDirectory(home: string, at: string): string {
	const safe = at.replaceAll(/[^0-9A-Za-z_-]/gu, "-");
	return path.join(home, "cutover-audit", safe);
}

function rollbackAudit(
	home: string,
	state: CanonicalCutoverState,
	at: string,
	reason: string,
): string {
	const directory = auditDirectory(home, at);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	copyIfPresent(
		path.join(home, "canonical"),
		path.join(directory, "canonical"),
	);
	copyIfPresent(
		path.join(home, "compatibility"),
		path.join(directory, "compatibility"),
	);
	const files = [
		"canonical/runtime.db",
		"canonical/runtime.db-wal",
		"canonical/runtime.db-shm",
		"tracker.db",
		"tracker.db-wal",
		"compatibility/legacy-projection.json",
	]
		.filter((relative) => fs.existsSync(path.join(home, relative)))
		.map((relative) => ({
			path: relative,
			bytes: fs.statSync(path.join(home, relative)).size,
			sha256: fileDigest(path.join(home, relative)),
		}));
	const manifestPath = path.join(directory, "rollback-audit.json");
	atomicJson(manifestPath, {
		schema_version: "golem.canonical-rollback-audit/v1",
		plan_hash: state.plan_hash,
		canonical_revision: state.canonical_revision,
		reason,
		recorded_at: at,
		canonical_data_preserved: true,
		files,
	});
	return path.relative(home, manifestPath);
}

function restoreCompatibilityDiscovery(
	home: string,
	state: CanonicalCutoverState,
): void {
	const checkpoint = state.checkpoint_manifest
		? path.resolve(home, state.checkpoint_manifest)
		: undefined;
	const prior = checkpoint
		? path.join(path.dirname(checkpoint), "legacy", "dashboard.json")
		: undefined;
	const target = path.join(home, "dashboard.json");
	if (prior && fs.existsSync(prior)) {
		copyIfPresent(prior, target);
		return;
	}
	const current = readJson(target);
	if (
		current &&
		typeof current === "object" &&
		(current as Record<string, unknown>).schema_version ===
			"golem.dashboard-discovery/v1" &&
		(current as Record<string, unknown>).generated === true &&
		(current as Record<string, unknown>).authoritative === false
	)
		fs.rmSync(target, { force: true });
}

export async function rollbackCanonicalCutover(
	home: string,
	options: {
		readonly reason?: string;
		readonly now?: () => string;
		readonly failpoint?: "after_authority";
	} = {},
): Promise<CutoverSoakResult> {
	const release = acquireLock(home);
	try {
		const state = canonicalCutoverStatus(home);
		const authority = readControlPlaneAuthority(home);
		if (
			state &&
			state.phase !== "rolled_back" &&
			authority.stage === "C3" &&
			authority.write_policy === "legacy_open" &&
			authority.plan_hash === state.plan_hash &&
			authority.rollback_audit
		) {
			const at = now(options);
			const resumed = transition(home, {
				planHash: state.plan_hash,
				phase: "rolled_back",
				canonicalRevision: state.canonical_revision,
				authorityRevision: authority.revision,
				rollbackAudit: authority.rollback_audit,
				reason: options.reason ?? "resumed completed authority rollback",
				at,
			});
			return Object.freeze({
				state: resumed,
				authority,
				rollback_triggered: true,
				triggers: Object.freeze([
					options.reason ?? "resumed completed authority rollback",
				]),
			});
		}
		if (
			!state ||
			(authority.stage !== "C4" && authority.write_policy !== "quiesced")
		)
			throw new CanonicalCutoverError(
				"cutover.not_active",
				"no canonical cutover is active or quiesced",
			);
		const at = now(options);
		const reason = options.reason ?? "operator rollback";
		const audit = rollbackAudit(home, state, at, reason);
		restoreCompatibilityDiscovery(home, state);
		const restored = writeControlPlaneAuthority(home, {
			stage: "C3",
			write_policy: "legacy_open",
			plan_hash: state.plan_hash,
			canonical_revision: state.canonical_revision,
			rollback_audit: audit,
			updated_at: at,
		});
		if (options.failpoint === "after_authority")
			throw new Error("canonical rollback failpoint after_authority");
		const rolledBack = transition(home, {
			planHash: state.plan_hash,
			phase: "rolled_back",
			canonicalRevision: state.canonical_revision,
			authorityRevision: restored.revision,
			rollbackAudit: audit,
			reason,
			at,
		});
		return Object.freeze({
			state: rolledBack,
			authority: restored,
			rollback_triggered: true,
			triggers: Object.freeze([reason]),
		});
	} finally {
		release();
	}
}

export async function evaluateCanonicalCutoverSoak(
	home: string,
	evidence: CutoverSoakEvidence = {},
	options: {
		readonly auto_rollback?: boolean;
		readonly now?: () => string;
	} = {},
): Promise<CutoverSoakResult> {
	const state = canonicalCutoverStatus(home);
	const authority = readControlPlaneAuthority(home);
	if (
		!state ||
		(state.phase !== "soaking" && state.phase !== "rollback_required") ||
		authority.stage !== "C4"
	)
		throw new CanonicalCutoverError(
			"cutover.not_active",
			"canonical cutover is not in its soak window",
		);
	const triggers = [
		...(evidence.parity_ok === false ? ["parity regression"] : []),
		...(evidence.health_ok === false ? ["health regression"] : []),
		...((evidence.unsafe_backlog ?? 0) > 0
			? [`unsafe backlog ${evidence.unsafe_backlog}`]
			: []),
		...(evidence.single_owner === false ? ["owner uniqueness regression"] : []),
	];
	if (triggers.length && options.auto_rollback !== false)
		return rollbackCanonicalCutover(home, {
			reason: `soak policy: ${triggers.join(", ")}`,
			...(options.now ? { now: options.now } : {}),
		});
	const phase: CanonicalCutoverPhase = triggers.length
		? "rollback_required"
		: "stable";
	const next = transition(home, {
		planHash: state.plan_hash,
		phase,
		canonicalRevision: state.canonical_revision,
		authorityRevision: authority.revision,
		reason: triggers.length ? triggers.join(", ") : "soak gates passed",
		at: now(options),
	});
	return Object.freeze({
		state: next,
		authority,
		rollback_triggered: false,
		triggers: Object.freeze(triggers),
	});
}
