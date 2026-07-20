import type {
	AliasReference,
	CapabilityRecord,
	ContractBoundary,
	DeliveryMode as ContractDeliveryMode,
	Harness as ContractHarness,
	DeliveryReadiness,
	EndpointRouteState,
	LifecycleState,
	ProjectLocationReference,
} from "@golem/contracts";

export type DatabaseScope = "runtime" | "tracker";
export type MigrationMode = "apply" | "dry-run";
export type RuntimeFailpoint = "before_commit" | "after_commit";

/** Canonical GOL-15/GOL-26 facts are owned by @golem/contracts. */
export type GenerationLifecycleState = LifecycleState;
export type EndpointLifecycleState = EndpointRouteState;
export type EndpointReadinessState = DeliveryReadiness;
export type DeliveryMode = ContractDeliveryMode;
export type ProjectLocationRelation = ProjectLocationReference["relation"];
export type Harness = ContractHarness;
export type SessionAliasKind = AliasReference["alias_kind"];
export type CapabilityQualification = CapabilityRecord["qualification"];

/** Closed runtime-v1 recovery/control vocabularies mirrored by SQL CHECKs. */
export type CommandStatus =
	| "accepted"
	| "rejected"
	| "executing"
	| "succeeded"
	| "failed"
	| "cancelled";
export type DeliveryEnvelopeStatus =
	| "pending"
	| "claimed"
	| "delivered"
	| "acknowledged"
	| "failed"
	| "cancelled"
	| "expired";
export type MigrationRunStatus =
	| "planned"
	| "dry_run"
	| "applying"
	| "applied"
	| "failed"
	| "rolled_back";
export type MigrationDecision =
	| "approved"
	| "rejected"
	| "deferred"
	| "applied"
	| "rolled_back";

export interface SchemaVersionedProvenance<
	Version extends "golem.lifecycle/v1" | "golem.fields/v1",
> {
	readonly schemaVersion: Version;
	readonly details: Readonly<Record<string, unknown>>;
}

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
		readonly canonicalPath: string;
		readonly observedPath?: string;
		readonly relation: ProjectLocationRelation;
	};
	readonly generation?: {
		readonly generationId: string;
		readonly sessionId: string;
		readonly projectId: string;
		readonly ordinal: number;
		readonly harness: Harness;
		readonly state: GenerationLifecycleState;
		readonly lifecycleProvenance: SchemaVersionedProvenance<"golem.lifecycle/v1">;
		readonly fieldProvenance: SchemaVersionedProvenance<"golem.fields/v1">;
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

/**
 * The runtime materializer owns this transaction boundary. Producers never
 * receive this capability or a database handle.
 */
export interface RuntimeMaterializationInput {
	readonly eventId: string;
	readonly deduplicationKey: string;
	readonly eventKind: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly provenance: Readonly<Record<string, unknown>>;
	readonly occurredAt: string;
	readonly producer: {
		readonly id: string;
		readonly sequence?: number;
	};
	readonly disposition: "accepted" | "illegal";
	readonly explanation: {
		readonly code: string;
		readonly details: Readonly<Record<string, unknown>>;
	};
	readonly mutation?: RuntimeCanonicalMutation;
	readonly outbox?: {
		readonly destination: "tracker" | "management";
		readonly payload: Readonly<Record<string, unknown>>;
	};
}

export interface RuntimeMaterializationResult {
	readonly disposition: "accepted" | "duplicate" | "stale" | "illegal";
	readonly outboxId?: string;
	readonly materializedAt?: string;
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

/** Bounded, redacted operational facts; never includes an outbox payload. */
export interface RuntimeOutboxHealth {
	readonly pending: number;
	readonly claimed: number;
	readonly published: number;
	readonly permanentFailures: number;
	readonly oldestRetryAgeMs?: number;
	readonly lastSuccessAt?: string;
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
	/** Apply is permitted only with the exact approved dry-run plan hash. */
	apply(scope: DatabaseScope, expectedPlanHash: string): MigrationResult;
	checkpointAndBackup(scope: DatabaseScope): string;
	recordRuntimeTransaction(
		input: RuntimeTransactionInput,
	): RuntimeTransactionResult;
	materializeRuntimeEvent(
		input: RuntimeMaterializationInput,
	): RuntimeMaterializationResult;
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
	runtimeOutboxHealth(): RuntimeOutboxHealth;
	status(): PersistenceStatus;
	close(): Promise<void>;
}
