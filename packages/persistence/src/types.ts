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

/**
 * Narrow tracker-store facts. This is the only tracker-facing view of the
 * owner; it intentionally omits SqliteConnection/Kysely and construction.
 */
export type TrackerJsonObject = Readonly<Record<string, unknown>>;
export type TrackerDeliveryReadiness =
	| "ready"
	| "held_busy"
	| "held_waiting"
	| "pull_only"
	| "next_turn"
	| "unsupported"
	| "unhealthy"
	| "uninitialized";
export type TrackerDeliveryMode =
	| "pull"
	| "native_channel"
	| "prompt_bridge"
	| "managed_app_server"
	| "next_turn";
export type TrackerCapabilityQualification =
	| "supported"
	| "experimental"
	| "unsupported"
	| "unknown";

export interface TrackerDeliveryEligibility {
	readonly recipientId: string;
	readonly generationId: string;
	readonly endpointId: string;
	readonly ownerFence: number;
	readonly readiness: TrackerDeliveryReadiness;
	readonly mode: TrackerDeliveryMode;
	readonly capabilities: readonly {
		readonly capability: string;
		readonly qualification: TrackerCapabilityQualification;
		readonly observedAt: string;
	}[];
}

export interface TrackerDeliveryEnvelope {
	readonly id: string;
	readonly rootId: string;
	readonly parentId?: string;
	readonly idempotencyKey: string;
	readonly senderId: string;
	readonly recipientId: string;
	readonly replyToRecipientId?: string;
	readonly kind: string;
	readonly payload: TrackerJsonObject;
	readonly endpoint: TrackerDeliveryEligibility;
	readonly status:
		| "pending"
		| "claimed"
		| "delivered"
		| "acknowledged"
		| "retrying"
		| "dead_letter"
		| "expired"
		| "cancelled";
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly deadlineAt?: string;
	readonly nextAttemptAt?: string;
	readonly createdAt: string;
}

export interface ClaimedTrackerDeliveryEnvelope
	extends TrackerDeliveryEnvelope {
	readonly claimToken: string;
	readonly claimOwner: string;
	readonly claimUntil: string;
}

export interface TrackerBusEvent {
	readonly sequence: number;
	readonly id: string;
	readonly deduplicationKey: string;
	readonly topic: string;
	readonly class: "tracker" | "lifecycle" | "custom";
	readonly payload: TrackerJsonObject;
	readonly createdAt: string;
}

export interface TrackerSubscription {
	readonly id: string;
	readonly name: string;
	readonly recipientId: string;
	readonly topic: string;
	readonly classes: readonly TrackerBusEvent["class"][];
	readonly cursor: number;
	readonly manual: boolean;
	readonly status: "active" | "offline" | "suspended";
	readonly createdAt: string;
}

export interface TrackerPendingSubscriptionEvents {
	readonly subscription: TrackerSubscription;
	readonly events: readonly TrackerBusEvent[];
	readonly fromSequence: number;
	readonly toSequence: number;
}

export interface TrackerPassiveDelta {
	readonly recipientId: string;
	readonly ticketId: string;
	readonly category: string;
	readonly baseline: TrackerJsonObject;
	readonly value: TrackerJsonObject;
	readonly eventId: string;
}

export interface ClaimedTrackerPassiveBatch {
	readonly recipientId: string;
	readonly leaseId: string;
	readonly leaseUntil: string;
	readonly cursor: number;
	readonly body: string;
	readonly entries: readonly TrackerPassiveDelta[];
}

export type TrackerCreateEnvelopeResult =
	| { readonly kind: "created"; readonly envelope: TrackerDeliveryEnvelope }
	| { readonly kind: "duplicate"; readonly envelope: TrackerDeliveryEnvelope }
	| { readonly kind: "conflict"; readonly reason: "id" | "idempotency_key" };
export type TrackerAppendBusEventResult =
	| { readonly kind: "created"; readonly event: TrackerBusEvent }
	| { readonly kind: "duplicate"; readonly event: TrackerBusEvent }
	| { readonly kind: "conflict"; readonly reason: "id" | "deduplication_key" };

export interface TrackerStorageCapability {
	createEnvelope(input: {
		readonly envelope: TrackerDeliveryEnvelope;
		readonly fingerprint: string;
	}): TrackerCreateEnvelopeResult;
	claimEnvelopes(input: {
		readonly workerId: string;
		readonly now: string;
		readonly claimUntil: string;
		readonly limit: number;
	}): readonly ClaimedTrackerDeliveryEnvelope[];
	settleEnvelope(input: {
		readonly id: string;
		readonly claimToken: string;
		readonly now: string;
		readonly status:
			| "pending"
			| "delivered"
			| "retrying"
			| "dead_letter"
			| "expired";
		readonly nextAttemptAt?: string;
		readonly error?: string;
	}): TrackerDeliveryEnvelope | undefined;
	acknowledgeEnvelope(input: {
		readonly id: string;
		readonly acknowledgementId: string;
		readonly recipientId: string;
		readonly payload: TrackerJsonObject;
		readonly now: string;
	}): boolean;
	createReplyEnvelope(input: {
		readonly parentId: string;
		readonly envelope: TrackerDeliveryEnvelope;
		readonly fingerprint: string;
	}): TrackerCreateEnvelopeResult;
	recoverEnvelopes(now: string): readonly TrackerDeliveryEnvelope[];
	appendBusEvent(input: {
		readonly event: Omit<TrackerBusEvent, "sequence">;
		readonly fingerprint: string;
	}): TrackerAppendBusEventResult;
	upsertSubscription(input: TrackerSubscription): TrackerSubscription;
	pendingSubscriptionEvents(input: {
		readonly id: string;
		readonly limit: number;
	}): TrackerPendingSubscriptionEvents | undefined;
	advanceSubscriptionCursor(input: {
		readonly id: string;
		readonly fromSequence: number;
		readonly toSequence: number;
	}): boolean;
	upsertPassiveDelta(
		input: TrackerPassiveDelta & { readonly now: string },
	): void;
	claimPassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly leaseUntil: string;
		readonly now: string;
	}): ClaimedTrackerPassiveBatch | undefined;
	commitPassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly now: string;
	}): boolean;
	releasePassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly now: string;
	}): boolean;
	prune(input: { readonly now: string; readonly before: string }): {
		readonly events: number;
		readonly envelopes: number;
		readonly auditId: string;
	};
	audit(): readonly {
		readonly id: string;
		readonly kind: string;
		readonly subjectId: string;
		readonly details: TrackerJsonObject;
		readonly createdAt: string;
	}[];
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
	/** Typed tracker store; no raw connection leaves the single owner. */
	trackerStorage(): TrackerStorageCapability;
	status(): PersistenceStatus;
	close(): Promise<void>;
}
