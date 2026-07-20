import { createHash } from "node:crypto";

import { isSecretLikeKey } from "../redact/redact.js";
import type {
	AuditAction,
	AuditActionKind,
	AuditFinding,
	AuditPlan,
	AuditSource,
	JsonRecord,
	LegacyReadResult,
} from "./types.js";
import { auditPlannerVersion } from "./types.js";

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stable(child)]),
		);
	}
	return value;
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function hash(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function short(value: string): string {
	return hash(value).slice(0, 16);
}

function stringField(record: JsonRecord, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function records(
	document: JsonRecord | undefined,
	key: string,
): readonly JsonRecord[] | undefined {
	const value = document?.[key];
	if (!Array.isArray(value)) return undefined;
	return value.filter(
		(entry): entry is JsonRecord =>
			entry !== null && typeof entry === "object" && !Array.isArray(entry),
	);
}

function pathIsSafe(value: string): boolean {
	const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
	return (
		normalized !== "/" &&
		!/(?:^|\/)(?:\.golem|\.config\/golem|renders)(?:\/|$)/u.test(normalized)
	);
}

function worktreeRoot(record: JsonRecord, location: string): string {
	const explicit =
		stringField(record, "main_path") ?? stringField(record, "worktree_of");
	if (explicit) return explicit;
	const marker = location
		.replaceAll("\\", "/")
		.match(/^(.*)\/\.worktrees\/[^/]+(?:\/.*)?$/u);
	return marker?.[1] ?? location;
}

function proposal(kind: string, value: string): string {
	return `${kind}:${short(value)}`;
}

function action(
	kind: AuditActionKind,
	reason: string,
	sourceIds: readonly string[],
	affectedIds: readonly string[],
	alternatives: readonly string[] = [],
	facts: Readonly<Record<string, string | number | boolean>> = {},
): AuditAction {
	return {
		id: `act_${short([kind, reason, ...sourceIds, ...affectedIds, ...alternatives].join("\u0000"))}`,
		kind,
		reason,
		source_ids: [...sourceIds].sort(),
		affected_ids: [...affectedIds].sort(),
		alternatives: [...alternatives].sort(),
		facts: stable(facts) as Readonly<Record<string, string | number | boolean>>,
	};
}

function sourceActions(
	sources: readonly AuditSource[],
	findings: readonly AuditFinding[],
): AuditAction[] {
	const result: AuditAction[] = [];
	for (const source of sources) {
		switch (source.status) {
			case "missing":
				result.push(
					action("ignore", "audit.source.missing", [source.id], [], [], {
						category: source.category,
					}),
				);
				break;
			case "unsafe":
			case "unreadable":
			case "malformed":
			case "changed":
				result.push(
					action(
						"quarantine",
						source.status === "changed"
							? "audit.source.changed_during_audit"
							: `audit.source.${source.status}`,
						[source.id],
						[],
						[],
						{ category: source.category },
					),
				);
				break;
			default:
				break;
		}
	}
	for (const finding of findings) {
		if (finding.code === "audit.source.entry_limit")
			result.push(
				action("quarantine", finding.code, [finding.source_id], [], [], {
					bounded: true,
				}),
			);
	}
	return result;
}

function projectActions(document: JsonRecord | undefined): AuditAction[] {
	const rows = records(document, "projects");
	if (!rows)
		return document
			? [
					action(
						"quarantine",
						"audit.projects.invalid_schema",
						["projects"],
						[],
					),
				]
			: [];
	const candidates = rows.map((row, index) => ({
		id: stringField(row, "id"),
		location: stringField(row, "path"),
		root: stringField(row, "path")
			? worktreeRoot(row, stringField(row, "path") ?? "")
			: undefined,
		index,
		row,
	}));
	const pathOwners = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		if (
			!candidate.id ||
			!candidate.location ||
			!candidate.root ||
			!pathIsSafe(candidate.location)
		)
			continue;
		const owner = pathOwners.get(candidate.root) ?? new Set<string>();
		owner.add(candidate.id);
		pathOwners.set(candidate.root, owner);
	}
	const byId = new Map<string, typeof candidates>();
	for (const candidate of candidates) {
		const key = candidate.id ?? `missing-${candidate.index}`;
		const group = byId.get(key) ?? [];
		group.push(candidate);
		byId.set(key, group);
	}
	const result: AuditAction[] = [];
	for (const [id, group] of [...byId.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const candidatePaths = group
			.map((entry) => entry.location)
			.filter((value): value is string => Boolean(value));
		const roots = group
			.map((entry) => entry.root)
			.filter((value): value is string => Boolean(value));
		const malformed = group.some(
			(entry) =>
				!entry.id ||
				!entry.location ||
				!entry.root ||
				!pathIsSafe(entry.location),
		);
		const conflictingOwner = roots.some(
			(root) => (pathOwners.get(root)?.size ?? 0) > 1,
		);
		const uniqueRoots = [...new Set(roots)].sort();
		const strongCanonicalId =
			/^prj_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
				id,
			);
		if (
			malformed ||
			conflictingOwner ||
			(uniqueRoots.length > 1 && !strongCanonicalId)
		) {
			result.push(
				action(
					"review",
					malformed
						? "compat.project.weak_or_unsafe"
						: "compat.project.ambiguous_location",
					["projects"],
					[],
					candidatePaths.map((value) => proposal("location", value)),
					{ evidence_count: group.length },
				),
			);
			continue;
		}
		const canonical = proposal("project", id);
		result.push(
			action(
				"attach",
				"compat.project.strong_registration",
				["projects"],
				[
					canonical,
					...candidatePaths.map((value) => proposal("location", value)),
				],
				[],
				{
					location_aliases: candidatePaths.length,
					worktree_aliases: candidatePaths.filter(
						(value) => worktreeRoot(group[0]?.row ?? {}, value) !== value,
					).length,
				},
			),
		);
	}
	return result;
}

interface SessionCandidate {
	readonly id?: string;
	readonly project?: string;
	readonly harness?: string;
	readonly terminal: boolean;
	readonly source: "sessions" | "facts";
}

function sessionCandidates(
	document: JsonRecord | undefined,
	source: SessionCandidate["source"],
): readonly SessionCandidate[] {
	const rows = records(document, source === "sessions" ? "sessions" : "facts");
	if (!rows) return [];
	return rows.map((row) => {
		const id = stringField(
			row,
			source === "sessions" ? "session_id" : "canonical_id",
		);
		const project = stringField(row, "project_id");
		const harness = stringField(row, "harness");
		return {
			...(id ? { id } : {}),
			...(project ? { project } : {}),
			...(harness ? { harness } : {}),
			terminal:
				Boolean(stringField(row, "ended_at")) ||
				["ended", "errored", "superseded"].includes(
					stringField(row, "status") ?? "",
				),
			source,
		};
	});
}

function sessionActions(
	sessionsDocument: JsonRecord | undefined,
	factsDocument: JsonRecord | undefined,
): AuditAction[] {
	const candidates = [
		...sessionCandidates(sessionsDocument, "sessions"),
		...sessionCandidates(factsDocument, "facts"),
	];
	const result: AuditAction[] = [];
	const byIdentity = new Map<string, SessionCandidate[]>();
	for (const candidate of candidates) {
		const key =
			candidate.id && candidate.project && candidate.harness
				? `${candidate.id}\u0000${candidate.project}\u0000${candidate.harness}`
				: `weak-${byIdentity.size}`;
		const group = byIdentity.get(key) ?? [];
		group.push(candidate);
		byIdentity.set(key, group);
	}
	const idsByRawId = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		if (!candidate.id || !candidate.project || !candidate.harness) continue;
		const scopes = idsByRawId.get(candidate.id) ?? new Set<string>();
		scopes.add(`${candidate.project}\u0000${candidate.harness}`);
		idsByRawId.set(candidate.id, scopes);
	}
	for (const group of byIdentity.values()) {
		const first = group[0];
		if (!first) continue;
		const sourceIds = [
			...new Set(group.map((candidate) => candidate.source)),
		].sort();
		if (!first.id || !first.project || !first.harness) {
			result.push(
				action("review", "compat.session.weak_evidence", sourceIds, [], [], {
					evidence_count: group.length,
				}),
			);
			continue;
		}
		const crossScope = (idsByRawId.get(first.id)?.size ?? 0) > 1;
		const canonical = proposal(
			"session",
			`${first.project}\u0000${first.harness}\u0000${first.id}`,
		);
		if (crossScope) {
			result.push(
				action(
					"review",
					"compat.session.ambiguous_scope",
					sourceIds,
					[],
					[canonical],
					{ evidence_count: group.length },
				),
			);
			continue;
		}
		result.push(
			action(
				group.some((candidate) => candidate.terminal) ? "retire" : "attach",
				group.some((candidate) => candidate.terminal)
					? "compat.session.terminal_history"
					: "compat.session.strong_alias",
				sourceIds,
				[canonical, proposal("project", first.project)],
				[],
				{
					evidence_count: group.length,
					terminal: group.some((candidate) => candidate.terminal),
				},
			),
		);
	}
	if (sessionsDocument && !records(sessionsDocument, "sessions"))
		result.push(
			action("quarantine", "audit.sessions.invalid_schema", ["sessions"], []),
		);
	if (factsDocument && !records(factsDocument, "facts"))
		result.push(
			action("quarantine", "audit.facts.invalid_schema", ["facts"], []),
		);
	return result;
}

function configActions(document: JsonRecord | undefined): AuditAction[] {
	if (!document) return [];
	const managed = new Set(["schema_version", "launch"]);
	const unknown = Object.keys(document).filter((key) => !managed.has(key));
	if (unknown.length === 0) return [];
	return [
		action(
			"ignore",
			"compat.config.unknown_keys_preserved",
			["config"],
			[],
			[],
			{
				unknown_key_count: unknown.length,
				secret_like_key_count: unknown.filter(isSecretLikeKey).length,
				managed_region_rewrite: false,
			},
		),
	];
}

function presentStoreActions(sources: readonly AuditSource[]): AuditAction[] {
	const createSources = new Set([
		"tracker",
		"channels",
		"leases",
		"opencode-bridges",
		"codex-supervisors",
		"dashboard",
		"journals",
		"spool",
		"gates",
		"ideas",
		"roles",
		"renders",
		"substrate-lock",
	]);
	return sources
		.filter(
			(source) => source.status === "present" && createSources.has(source.id),
		)
		.map((source) =>
			action(
				"create",
				"compat.source.evidence_snapshot",
				[source.id],
				[proposal("evidence", source.id)],
				[],
				{ category: source.category },
			),
		);
}

export function planLegacyMigration(
	read: LegacyReadResult,
	options: { readonly planner_version?: string } = {},
): AuditPlan {
	const sources = [...read.sources].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
	const findings = [...read.findings].sort((left, right) =>
		`${left.source_id}\u0000${left.code}`.localeCompare(
			`${right.source_id}\u0000${right.code}`,
		),
	);
	const actions = [
		...sourceActions(sources, findings),
		...projectActions(read.documents.projects),
		...sessionActions(read.documents.sessions, read.documents.facts),
		...configActions(read.documents.config),
		...presentStoreActions(sources),
	].sort((left, right) => left.id.localeCompare(right.id));
	const sourceManifestHash = hash(sources);
	const counts = actions.reduce<Record<string, number>>((result, current) => {
		result[current.reason] = (result[current.reason] ?? 0) + 1;
		return result;
	}, {});
	const estimatedSourceBytes = sources.reduce(
		(total, source) => total + (source.size_bytes ?? 0),
		0,
	);
	const plannerVersion = options.planner_version ?? auditPlannerVersion;
	const unsigned = {
		schema_version: "golem.compat-migration-plan/v1" as const,
		planner_version: plannerVersion,
		mode: "dry_run" as const,
		source_manifest_hash: sourceManifestHash,
		sources,
		findings,
		actions,
		counts_by_reason: counts,
		requirements: {
			backup: {
				required: true as const,
				artifacts: [
					"legacy-file-manifest",
					"tracker-db-backup",
					"runtime-db-backup",
				],
				estimated_source_bytes: estimatedSourceBytes,
			},
			disk: { minimum_free_bytes: estimatedSourceBytes * 2 },
			compatibility_window: "C0-C4" as const,
			rollback_artifact: `rollback:${sourceManifestHash.slice(0, 24)}`,
		},
	};
	const planHash = hash(unsigned);
	return {
		...unsigned,
		plan_id: `migration-plan:${planHash.slice(0, 24)}`,
		plan_hash: planHash,
	};
}

export function stableAuditPlanJson(plan: AuditPlan): string {
	return stableJson(plan);
}
