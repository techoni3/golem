import type { ContractBoundary } from "@golem/contracts";

export type DatabaseScope = "runtime" | "tracker";
export type MigrationMode = "apply" | "dry-run";
export type RuntimeFailpoint = "before_commit" | "after_commit";

/** Injected once by the owning process so persistence never invents test time. */
export interface PersistenceClock {
	now(): string;
	after(milliseconds: number): string;
}

export interface PersistenceBoundary {
	readonly contract: ContractBoundary;
}

export interface PersistencePaths {
	readonly runtimePath: string;
	readonly trackerPath: string;
	readonly lockPath?: string;
}

export interface PersistenceOpenOptions {
	readonly ownerId?: string;
	readonly clock?: PersistenceClock;
}

export interface MigrationDefinition {
	readonly id: string;
	readonly checksum: string;
	readonly sql: string;
}

export interface DryRunEvidence {
	readonly integrity: "ok" | string;
	readonly foreignKeyViolations: number;
	readonly applied: readonly string[];
}

export interface MigrationPlan {
	readonly scope: DatabaseScope;
	readonly mode: MigrationMode;
	readonly currentVersion: number;
	readonly targetVersion: number;
	readonly migrations: readonly Pick<MigrationDefinition, "id" | "checksum">[];
	readonly pending: readonly Pick<MigrationDefinition, "id" | "checksum">[];
	readonly requiresBackup: boolean;
	readonly estimatedBackupBytes: number;
	readonly planHash: string;
	readonly dryRun?: DryRunEvidence;
}

export interface MigrationResult extends MigrationPlan {
	readonly backupPath?: string;
	readonly applied: readonly string[];
}

export interface DatabaseHealth {
	readonly foreignKeys: boolean;
	readonly journalMode: string;
	readonly busyTimeoutMs: number;
	readonly synchronous: string | number;
	readonly integrity: "ok" | string;
	readonly foreignKeyViolations: number;
	readonly userVersion: number;
}

export interface PersistenceStatus {
	readonly owner: {
		readonly lockPath: string;
		readonly ownerId: string;
		readonly nonce: string;
		readonly pid: number;
	};
	readonly runtime: DatabaseHealth;
	readonly tracker: DatabaseHealth & {
		readonly baseline: "managed" | "unmanaged";
	};
}

export interface RuntimeCanonicalMutation {
	readonly project?: {
		readonly projectId: string;
		readonly name: string;
		readonly locationId: string;
		readonly location: string;
		readonly observedPath: string;
	};
	readonly generation?: {
		readonly generationId: string;
		readonly sessionId: string;
		readonly projectId: string;
		readonly ordinal: number;
		readonly harness: string;
		readonly state:
			| "starting"
			| "working"
			| "idle"
			| "waiting"
			| "ended"
			| "errored"
			| "superseded";
	};
}

export interface RuntimeTransactionInput {
	readonly eventId: string;
	readonly deduplicationKey: string;
	readonly eventKind: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly provenance: Readonly<Record<string, unknown>>;
	readonly occurredAt: string;
	readonly mutation: RuntimeCanonicalMutation;
	readonly outbox: {
		readonly destination: "tracker" | "management";
		readonly payload: Readonly<Record<string, unknown>>;
	};
	readonly failpoint?: RuntimeFailpoint;
}

export interface RuntimeTransactionResult {
	readonly disposition: "accepted" | "duplicate";
	readonly outboxId?: string;
}

export interface ClaimedOutboxRecord {
	readonly id: string;
	readonly destination: "tracker" | "management";
	readonly payload: Readonly<Record<string, unknown>>;
	readonly claimToken: string;
	readonly attempts: number;
}

export interface RuntimeOutboxFailure {
	readonly status: "pending" | "permanent_failure";
	readonly attempts: number;
	readonly nextAttemptAt?: string;
	readonly permanentFailureAt?: string;
}

export class PersistenceMigrationError extends Error {
	readonly code:
		| "checksum_drift"
		| "schema_too_new"
		| "plan_mismatch"
		| "migration_failed"
		| "migration_ledger_invalid"
		| "backup_failed";

	constructor(code: PersistenceMigrationError["code"], message: string) {
		super(message);
		this.name = "PersistenceMigrationError";
		this.code = code;
	}
}

export class PersistenceOwnerConflictError extends Error {
	readonly diagnostic: Readonly<Record<string, unknown>>;

	constructor(diagnostic: Readonly<Record<string, unknown>>) {
		super("persistence owner already holds the runtime lock");
		this.name = "PersistenceOwnerConflictError";
		this.diagnostic = diagnostic;
	}
}

export class RuntimeFailpointError extends Error {
	readonly failpoint: RuntimeFailpoint;

	constructor(failpoint: RuntimeFailpoint) {
		super(`runtime failpoint reached: ${failpoint}`);
		this.name = "RuntimeFailpointError";
		this.failpoint = failpoint;
	}
}

/**
 * The only writable persistence capability exported from this package. Raw
 * better-sqlite3/Kysely handles and the owner constructor remain module-private.
 */
export interface PersistenceWriteCapability {
	plan(scope: DatabaseScope, mode?: MigrationMode): MigrationPlan;
	apply(scope: DatabaseScope, expectedPlanHash?: string): MigrationResult;
	checkpointAndBackup(scope: DatabaseScope): string;
	recordRuntimeTransaction(
		input: RuntimeTransactionInput,
	): RuntimeTransactionResult;
	claimRuntimeOutbox(
		workerId: string,
		limit: number,
		leaseMs?: number,
	): readonly ClaimedOutboxRecord[];
	replayRuntimeOutbox(): number;
	ackRuntimeOutbox(id: string, claimToken: string): boolean;
	failRuntimeOutbox(
		id: string,
		claimToken: string,
		error: string,
	): RuntimeOutboxFailure | undefined;
	status(): PersistenceStatus;
	close(): Promise<void>;
}
