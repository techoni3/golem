import type { AuditPlan } from "../plan/types.js";

export type MigrationApplyStatus = "applied" | "rolled_back" | "failed";

export interface MigrationStatus {
	readonly schema_version: "golem.compat-migration-status/v1";
	readonly status: MigrationApplyStatus;
	readonly plan_id: string;
	readonly plan_hash: string;
	readonly source_manifest_hash: string;
	readonly applied_at: string;
	readonly backup_directory: string;
	readonly rollback_command: string;
	readonly compatibility_projection: string;
	readonly compatibility_mode: "read_only_generated";
	readonly imported: Readonly<{
		projects: number;
		sessions: number;
		generations: number;
		aliases: number;
	}>;
	readonly source_bytes: number;
}

export interface ApplyMigrationOptions {
	readonly home: string;
	/** Must be copied from the dry-run plan; an omitted value is never inferred. */
	readonly expected_plan_hash: string;
	/** Injectable only for the recovery journey; a failpoint restores canonical backup. */
	readonly failpoint?: "before_commit" | "after_projection";
	readonly now?: () => string;
}

export interface ApplyMigrationResult {
	readonly plan: AuditPlan;
	readonly status: MigrationStatus;
}

export class MigrationApplyError extends Error {
	readonly code:
		| "migration.plan_hash_required"
		| "migration.plan_hash_mismatch"
		| "migration.source_changed"
		| "migration.review_required"
		| "migration.locked"
		| "migration.disk_insufficient"
		| "migration.backup_failed"
		| "migration.import_rejected"
		| "migration.not_applied";

	constructor(code: MigrationApplyError["code"], message: string) {
		super(message);
		this.name = "MigrationApplyError";
		this.code = code;
	}
}
