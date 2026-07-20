/**
 * The audit plan is deliberately not an apply command.  Its identifiers are
 * stable proposals only, and its source paths are home-relative/redacted.
 */
export const auditPlannerVersion = "golem.compat.audit/v1";

export type AuditSourceStatus =
	| "present"
	| "missing"
	| "unsafe"
	| "unreadable"
	| "malformed"
	| "changed";

export interface AuditSource {
	readonly id: string;
	readonly path: string;
	readonly category:
		| "registry"
		| "state"
		| "config"
		| "history"
		| "render"
		| "database";
	readonly status: AuditSourceStatus;
	readonly fingerprint?: string;
	readonly size_bytes?: number;
	readonly mode?: string;
	readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditFinding {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly source_id: string;
	readonly path: string;
}

export type AuditActionKind =
	| "create"
	| "attach"
	| "review"
	| "quarantine"
	| "ignore"
	| "retire";

export interface AuditAction {
	readonly id: string;
	readonly kind: AuditActionKind;
	readonly reason: string;
	readonly source_ids: readonly string[];
	readonly affected_ids: readonly string[];
	readonly alternatives: readonly string[];
	readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditPlan {
	readonly schema_version: "golem.compat-migration-plan/v1";
	readonly planner_version: string;
	readonly mode: "dry_run";
	readonly plan_id: string;
	readonly plan_hash: string;
	readonly source_manifest_hash: string;
	readonly sources: readonly AuditSource[];
	readonly findings: readonly AuditFinding[];
	readonly actions: readonly AuditAction[];
	readonly counts_by_reason: Readonly<Record<string, number>>;
	readonly requirements: {
		readonly backup: {
			readonly required: true;
			readonly artifacts: readonly string[];
			readonly estimated_source_bytes: number;
		};
		readonly disk: {
			readonly minimum_free_bytes: number;
		};
		readonly compatibility_window: "C0-C4";
		readonly rollback_artifact: string;
	};
}

export type JsonRecord = Readonly<Record<string, unknown>>;

export interface LegacyReadResult {
	readonly sources: readonly AuditSource[];
	readonly documents: Readonly<Record<string, JsonRecord>>;
	readonly findings: readonly AuditFinding[];
}
