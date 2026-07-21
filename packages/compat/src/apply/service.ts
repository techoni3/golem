import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
	type Harness,
	type RuntimeSignalV1,
	RuntimeSignalV1Schema,
} from "@golem/contracts";
import { openLegacyMigrationPersistence } from "@golem/persistence/migration-compat";
import { createSessionService } from "@golem/runtime";

import { auditLegacyHome } from "../audit/audit.js";
import type { JsonRecord, LegacyReadResult } from "../plan/types.js";
import {
	legacySourceRelativePaths,
	readLegacyHome,
} from "../readers/safe-reader.js";
import {
	redactDiagnosticText,
	redactedDisplayPath,
	redactedHomePath,
} from "../redact/redact.js";
import type {
	ApplyMigrationOptions,
	ApplyMigrationResult,
	MigrationStatus,
} from "./types.js";
import { MigrationApplyError } from "./types.js";

const statusFilename = "migration-status.json";
const canonicalDirectoryName = "canonical";
const compatibilityDirectoryName = "compatibility";
const migrationLockFilename = ".migration-apply.lock";

type MutableRecord = Record<string, unknown>;

function now(options: ApplyMigrationOptions): string {
	return options.now?.() ?? new Date().toISOString();
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableOpaqueId(
	prefix: "prj" | "loc" | "ses" | "gen" | "evt" | "prod",
	seed: string,
): string {
	const hex = digest(seed);
	const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	return `${prefix}_${uuid}`;
}

function value(record: JsonRecord, key: string): string | undefined {
	const candidate = record[key];
	return typeof candidate === "string" && candidate.trim().length > 0
		? candidate.trim()
		: undefined;
}

function records(
	document: JsonRecord | undefined,
	key: string,
): readonly JsonRecord[] {
	const candidate = document?.[key];
	return Array.isArray(candidate)
		? candidate.filter(
				(entry): entry is JsonRecord =>
					Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
			)
		: [];
}

function isHarness(value: string | undefined): value is Harness {
	return (
		value === "claude" ||
		value === "codex" ||
		value === "opencode" ||
		value === "pi"
	);
}

function pathIsSafe(candidate: string): boolean {
	return (
		path.isAbsolute(candidate) &&
		!candidate.includes("\0") &&
		!candidate.split(path.sep).includes("..")
	);
}

function worktreeRoot(candidate: string): string {
	const normalized = candidate.replaceAll("\\", "/");
	const match = normalized.match(/^(.*)\/\.worktrees\/[^/]+(?:\/.*)?$/u);
	return match?.[1] ?? normalized;
}

function projectId(rawId: string, planHash: string): string {
	return /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
		rawId,
	)
		? rawId
		: stableOpaqueId("prj", `${planHash}\0project\0${rawId}`);
}

function atomicJson(target: string, body: unknown): void {
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	fs.renameSync(temporary, target);
}

function statusPath(home: string): string {
	return path.join(home, statusFilename);
}

function backupDirectoryFor(home: string, planHash: string): string {
	return path.join(home, "migration-backups", planHash.slice(0, 24));
}

function publicBackupDirectory(planHash: string): string {
	return redactedHomePath(`migration-backups/${planHash.slice(0, 24)}`);
}

function publicProjectionPath(): string {
	return redactedHomePath(
		`${compatibilityDirectoryName}/legacy-projection.json`,
	);
}

function publicRollbackCommand(): string {
	return "golem migrate rollback --home $GOLEM_HOME";
}

function publicStatus(status: MigrationStatus): MigrationStatus {
	return Object.freeze({
		...status,
		backup_directory: publicBackupDirectory(status.plan_hash),
		rollback_command: publicRollbackCommand(),
		compatibility_projection: publicProjectionPath(),
	});
}

function readStatus(home: string): MigrationStatus | undefined {
	try {
		const candidate: unknown = JSON.parse(
			fs.readFileSync(statusPath(home), "utf8"),
		);
		if (!candidate || typeof candidate !== "object") return undefined;
		const record = candidate as MutableRecord;
		return record.schema_version === "golem.compat-migration-status/v1" &&
			typeof record.plan_hash === "string" &&
			typeof record.plan_id === "string" &&
			(record.status === "applied" ||
				record.status === "rolled_back" ||
				record.status === "failed")
			? publicStatus(candidate as MigrationStatus)
			: undefined;
	} catch {
		return undefined;
	}
}

function acquireLock(home: string): () => void {
	const lockPath = path.join(home, migrationLockFilename);
	try {
		fs.writeFileSync(
			lockPath,
			`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
			{
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			},
		);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EEXIST"
		)
			throw new MigrationApplyError(
				"migration.locked",
				"another migration apply owns this home",
			);
		throw error;
	}
	return () => {
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			// Lock removal must not hide a completed durable result.
		}
	};
}

function ensureFreeSpace(home: string, required: number): void {
	try {
		const stat = fs.statfsSync(home);
		const available = Number(stat.bavail) * Number(stat.bsize);
		if (!Number.isSafeInteger(available) || available < required)
			throw new MigrationApplyError(
				"migration.disk_insufficient",
				"migration requires more free space before creating backups",
			);
	} catch (error) {
		if (error instanceof MigrationApplyError) throw error;
		throw new MigrationApplyError(
			"migration.disk_insufficient",
			"migration could not verify free space before creating backups",
		);
	}
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

function backupSources(home: string, planHash: string): string {
	const directory = backupDirectoryFor(home, planHash);
	try {
		if (fs.existsSync(directory))
			throw new Error("backup directory already exists for this plan");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		for (const source of legacySourceRelativePaths)
			copyIfPresent(
				path.join(home, source.relative),
				path.join(directory, "legacy", source.relative),
			);
		const canonical = path.join(home, canonicalDirectoryName);
		if (fs.existsSync(canonical))
			copyIfPresent(canonical, path.join(directory, "canonical-before"));
		atomicJson(path.join(directory, "manifest.json"), {
			schema_version: "golem.compat-migration-backup/v1",
			plan_hash: planHash,
			canonical_before_present: fs.existsSync(canonical),
			sources: legacySourceRelativePaths.map((source) => source.id),
		});
		return directory;
	} catch (error) {
		throw new MigrationApplyError(
			"migration.backup_failed",
			error instanceof Error
				? `backup failed: ${redactDiagnosticText(error.message)}`
				: "backup failed",
		);
	}
}

function restoreCanonical(home: string, backupDirectory: string): void {
	const canonical = path.join(home, canonicalDirectoryName);
	fs.rmSync(canonical, { recursive: true, force: true });
	const previous = path.join(backupDirectory, "canonical-before");
	if (fs.existsSync(previous))
		fs.cpSync(previous, canonical, { dereference: false, recursive: true });
	fs.rmSync(path.join(home, compatibilityDirectoryName), {
		recursive: true,
		force: true,
	});
}

interface ImportedProject {
	readonly rawId: string;
	readonly canonicalId: string;
	readonly name: string;
	readonly paths: readonly string[];
}

function importableProjects(
	read: LegacyReadResult,
	planHash: string,
): readonly ImportedProject[] {
	const groups = new Map<string, JsonRecord[]>();
	for (const row of records(read.documents.projects, "projects")) {
		const id = value(row, "id");
		const location = value(row, "path");
		if (!id || !location || !pathIsSafe(location)) continue;
		const group = groups.get(id) ?? [];
		group.push(row);
		groups.set(id, group);
	}
	return [...groups.entries()].flatMap(([rawId, group]) => {
		const paths = [
			...new Set(
				group
					.map((row) => value(row, "path"))
					.filter((entry): entry is string => Boolean(entry)),
			),
		].sort();
		const roots = new Set(paths.map(worktreeRoot));
		const strongId =
			/^prj_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
				rawId,
			);
		if (paths.length === 0 || (roots.size > 1 && !strongId)) return [];
		return [
			{
				rawId,
				canonicalId: projectId(rawId, planHash),
				name: value(group[0] ?? {}, "name") ?? rawId,
				paths,
			},
		];
	});
}

interface ImportedSession {
	readonly rawId: string;
	readonly projectId: string;
	readonly harness: Harness;
	readonly terminal: boolean;
	readonly observedAt: string;
}

function importableSessions(
	read: LegacyReadResult,
	projects: ReadonlyMap<string, string>,
): readonly ImportedSession[] {
	const candidates: ImportedSession[] = [];
	for (const row of records(read.documents.sessions, "sessions")) {
		const rawId = value(row, "session_id");
		const legacyProject = value(row, "project_id");
		const harness = value(row, "harness");
		const projectIdValue = legacyProject
			? projects.get(legacyProject)
			: undefined;
		if (rawId && projectIdValue && isHarness(harness))
			candidates.push({
				rawId,
				projectId: projectIdValue,
				harness,
				terminal: false,
				observedAt: "2000-01-01T00:00:00.000Z",
			});
	}
	for (const row of records(read.documents.facts, "facts")) {
		const rawId = value(row, "canonical_id");
		const legacyProject = value(row, "project_id");
		const harness = value(row, "harness");
		const projectIdValue = legacyProject
			? projects.get(legacyProject)
			: undefined;
		if (rawId && projectIdValue && isHarness(harness)) {
			const endedAt = value(row, "ended_at");
			candidates.push({
				rawId,
				projectId: projectIdValue,
				harness,
				terminal: value(row, "status") === "ended" || Boolean(endedAt),
				observedAt:
					endedAt && !Number.isNaN(Date.parse(endedAt))
						? endedAt
						: "2000-01-01T00:00:00.000Z",
			});
		}
	}
	const scopes = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		const entries = scopes.get(candidate.rawId) ?? new Set<string>();
		entries.add(`${candidate.projectId}\0${candidate.harness}`);
		scopes.set(candidate.rawId, entries);
	}
	const byScope = new Map<string, ImportedSession>();
	for (const candidate of candidates) {
		if ((scopes.get(candidate.rawId)?.size ?? 0) !== 1) continue;
		const key = `${candidate.rawId}\0${candidate.projectId}\0${candidate.harness}`;
		const previous = byScope.get(key);
		if (
			!previous ||
			candidate.terminal ||
			candidate.observedAt > previous.observedAt
		)
			byScope.set(key, candidate);
	}
	return [...byScope.values()].sort((left, right) =>
		`${left.projectId}\0${left.rawId}`.localeCompare(
			`${right.projectId}\0${right.rawId}`,
		),
	);
}

function signal(input: {
	readonly planHash: string;
	readonly event: string;
	readonly eventKind: RuntimeSignalV1["event_kind"];
	readonly harness: Harness;
	readonly observedAt: string;
	readonly payload: unknown;
}): RuntimeSignalV1 {
	const producer = stableOpaqueId("prod", `${input.planHash}\0producer`);
	return RuntimeSignalV1Schema.parse({
		schema_version: "golem.runtime-signal/v1",
		event_id: stableOpaqueId("evt", `${input.planHash}\0${input.event}`),
		event_kind: input.eventKind,
		producer: "legacy-migration",
		producer_instance_id: producer,
		harness: input.harness,
		correlation_id: `migration:${input.planHash.slice(0, 24)}`,
		deduplication_key: `migration:${input.planHash.slice(0, 40)}:${input.event}`,
		clocks: {
			source_observed_at: input.observedAt,
			received_at: input.observedAt,
		},
		provenance: {
			source: "legacy_import",
			confidence: "legacy",
			evidence_id: input.planHash.slice(0, 64),
		},
		clear_fields: [],
		payload: input.payload,
	});
}

function writeCompatibilityProjection(input: {
	readonly home: string;
	readonly planHash: string;
	readonly projections: ReturnType<
		typeof openLegacyMigrationPersistence
	>["projections"];
}): string {
	const target = path.join(
		input.home,
		compatibilityDirectoryName,
		"legacy-projection.json",
	);
	const projects = input.projections.projects().map((project) => ({
		id: project.projectId,
		name: project.name,
		path: project.locations[0]
			? redactedDisplayPath(project.locations[0].canonicalPath)
			: null,
	}));
	const sessions = input.projections.sessions().map((session) => ({
		session_id: session.sessionId,
		project_id: session.projectId,
		generation_count: session.generations.length,
	}));
	atomicJson(target, {
		schema_version: "golem.compatibility-projection/v1",
		generated: true,
		canonical_revision: input.projections.revision(),
		plan_hash: input.planHash,
		projects,
		sessions,
	});
	return publicProjectionPath();
}

function assertApplyable(
	plan: Awaited<ReturnType<typeof auditLegacyHome>>,
	expected: string,
): void {
	if (!expected.trim())
		throw new MigrationApplyError(
			"migration.plan_hash_required",
			"an explicit dry-run plan hash is required",
		);
	if (plan.plan_hash !== expected)
		throw new MigrationApplyError(
			"migration.plan_hash_mismatch",
			"the supplied plan hash does not match this dry-run plan",
		);
	if (
		plan.actions.some(
			(action) => action.kind === "review" || action.kind === "quarantine",
		)
	)
		throw new MigrationApplyError(
			"migration.review_required",
			"unresolved review or quarantine actions must be decided before apply",
		);
}

export async function migrationStatus(
	home: string,
): Promise<MigrationStatus | undefined> {
	return readStatus(home);
}

export async function applyLegacyMigration(
	options: ApplyMigrationOptions,
): Promise<ApplyMigrationResult> {
	const approvedPlan = await auditLegacyHome(options.home);
	assertApplyable(approvedPlan, options.expected_plan_hash);
	const release = acquireLock(options.home);
	let backupDirectory: string | undefined;
	try {
		const plan = await auditLegacyHome(options.home);
		if (plan.plan_hash !== approvedPlan.plan_hash)
			throw new MigrationApplyError(
				"migration.source_changed",
				"legacy source changed before migration acquired its apply lock",
			);
		const rechecked = await auditLegacyHome(options.home);
		if (rechecked.plan_hash !== plan.plan_hash)
			throw new MigrationApplyError(
				"migration.source_changed",
				"legacy source changed while migration was reading its import snapshot",
			);
		ensureFreeSpace(options.home, plan.requirements.disk.minimum_free_bytes);
		backupDirectory = backupSources(options.home, plan.plan_hash);
		const snapshotHome = path.join(backupDirectory, "legacy");
		const snapshotPlan = await auditLegacyHome(snapshotHome);
		if (snapshotPlan.source_manifest_hash !== plan.source_manifest_hash)
			throw new MigrationApplyError(
				"migration.source_changed",
				"backup snapshot no longer matches the approved source fingerprint",
			);
		const snapshot = await readLegacyHome(snapshotHome);
		const canonical = path.join(options.home, canonicalDirectoryName);
		const target = openLegacyMigrationPersistence({
			runtimePath: path.join(canonical, "runtime.db"),
			trackerPath: path.join(canonical, "tracker.db"),
			lockPath: path.join(canonical, "migration.owner.lock"),
		});
		try {
			const projectRows = importableProjects(snapshot, plan.plan_hash);
			const projectMappings = new Map(
				projectRows.map((entry) => [entry.rawId, entry.canonicalId]),
			);
			for (const project of projectRows) {
				for (const legacyPath of project.paths) {
					const locationId = stableOpaqueId(
						"loc",
						`${plan.plan_hash}\0${project.rawId}\0${legacyPath}`,
					);
					const result = target.projects.observe({
						projectId: project.canonicalId,
						name: project.name,
						location: {
							locationId,
							canonicalPath: legacyPath,
							relation: legacyPath.includes("/.worktrees/")
								? "worktree"
								: "legacy",
							source: "legacy_import",
							evidence: {
								source_manifest_hash: plan.source_manifest_hash,
								legacy_project_id: project.rawId,
							},
							observedAt: now(options),
						},
						identityKey: `legacy:migration:${project.rawId}`,
						metadata: { migration_plan_hash: plan.plan_hash },
						source: "legacy_import",
						eventId: stableOpaqueId(
							"evt",
							`${plan.plan_hash}\0project\0${project.rawId}\0${legacyPath}`,
						),
						deduplicationKey: `migration:${plan.plan_hash}:project:${digest(`${project.rawId}\0${legacyPath}`).slice(0, 24)}`,
						payload: {
							kind: "project.observed",
							legacy_project_id: project.rawId,
						},
						provenance: {
							source: "legacy_import",
							confidence: "legacy",
							source_manifest_hash: plan.source_manifest_hash,
						},
						occurredAt: now(options),
					});
					if (
						result.disposition !== "accepted" &&
						result.disposition !== "duplicate"
					)
						throw new MigrationApplyError(
							"migration.import_rejected",
							"canonical project import rejected",
						);
				}
			}
			const sessions = createSessionService({
				projects: target.projects,
				sessions: target.sessions,
			});
			const sessionRows = importableSessions(snapshot, projectMappings);
			for (const row of sessionRows) {
				const canonicalSessionId = stableOpaqueId(
					"ses",
					`${plan.plan_hash}\0${row.projectId}\0${row.harness}\0${row.rawId}`,
				);
				const generationId = stableOpaqueId(
					"gen",
					`${plan.plan_hash}\0${row.projectId}\0${row.harness}\0${row.rawId}\0first`,
				);
				const started = sessions.apply(
					signal({
						planHash: plan.plan_hash,
						event: `session-start:${row.projectId}:${row.harness}:${row.rawId}`,
						eventKind: "session.started",
						harness: row.harness,
						observedAt: row.observedAt,
						payload: {
							kind: "session.started",
							generation: {
								project_id: row.projectId,
								session_id: canonicalSessionId,
								generation_id: generationId,
							},
							metadata: { migration_plan_hash: plan.plan_hash },
						},
					}),
					{
						projectId: row.projectId,
						harness: row.harness,
						aliasKind: "migration_relation",
						alias: row.rawId,
						sessionId: canonicalSessionId,
						generationId,
						source: "legacy_import",
						provenance: {
							source_manifest_hash: plan.source_manifest_hash,
							plan_hash: plan.plan_hash,
						},
					},
				);
				if (
					started.disposition !== "accepted" &&
					started.disposition !== "duplicate"
				)
					throw new MigrationApplyError(
						"migration.import_rejected",
						`canonical session import rejected: ${started.code}`,
					);
				if (row.terminal) {
					const ended = sessions.apply(
						signal({
							planHash: plan.plan_hash,
							event: `session-end:${row.projectId}:${row.harness}:${row.rawId}`,
							eventKind: "session.ended",
							harness: row.harness,
							observedAt: row.observedAt,
							payload: {
								kind: "session.ended",
								generation: {
									project_id: row.projectId,
									session_id: canonicalSessionId,
									generation_id: generationId,
								},
								disposition: "ended",
							},
						}),
					);
					if (
						ended.disposition !== "accepted" &&
						ended.disposition !== "duplicate"
					)
						throw new MigrationApplyError(
							"migration.import_rejected",
							`canonical terminal import rejected: ${ended.code}`,
						);
				}
			}
			if (options.failpoint === "before_commit")
				throw new Error("migration failpoint before_commit");
			const finalPlan = await auditLegacyHome(options.home);
			if (finalPlan.source_manifest_hash !== plan.source_manifest_hash)
				throw new MigrationApplyError(
					"migration.source_changed",
					"legacy source changed while migration was importing its snapshot",
				);
			const projection = writeCompatibilityProjection({
				home: options.home,
				planHash: plan.plan_hash,
				projections: target.projections,
			});
			if (options.failpoint === "after_projection")
				throw new Error("migration failpoint after_projection");
			const status: MigrationStatus = Object.freeze({
				schema_version: "golem.compat-migration-status/v1",
				status: "applied",
				plan_id: plan.plan_id,
				plan_hash: plan.plan_hash,
				source_manifest_hash: plan.source_manifest_hash,
				applied_at: now(options),
				backup_directory: publicBackupDirectory(plan.plan_hash),
				rollback_command: publicRollbackCommand(),
				compatibility_projection: projection,
				compatibility_mode: "read_only_generated",
				imported: {
					projects: projectRows.length,
					sessions: sessionRows.length,
					generations: sessionRows.length,
					aliases: sessionRows.length,
				},
				source_bytes: plan.requirements.backup.estimated_source_bytes,
			});
			atomicJson(statusPath(options.home), status);
			return { plan, status };
		} finally {
			await target.close();
		}
	} catch (error) {
		if (backupDirectory) {
			try {
				restoreCanonical(options.home, backupDirectory);
			} catch {
				/* retain primary failure */
			}
		}
		if (error instanceof MigrationApplyError) throw error;
		throw new MigrationApplyError(
			"migration.import_rejected",
			error instanceof Error
				? redactDiagnosticText(error.message)
				: "migration apply failed",
		);
	} finally {
		release();
	}
}

export async function rollbackLegacyMigration(
	home: string,
): Promise<MigrationStatus> {
	const current = readStatus(home);
	if (current?.status !== "applied")
		throw new MigrationApplyError(
			"migration.not_applied",
			"no applied migration is available to roll back",
		);
	const release = acquireLock(home);
	try {
		restoreCanonical(home, backupDirectoryFor(home, current.plan_hash));
		const rolledBack: MigrationStatus = Object.freeze({
			...current,
			status: "rolled_back",
			applied_at: new Date().toISOString(),
		});
		atomicJson(statusPath(home), rolledBack);
		return rolledBack;
	} finally {
		release();
	}
}

export { MigrationApplyError };
