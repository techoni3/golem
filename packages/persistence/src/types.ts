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
	RuntimeSignalV1,
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

/** Public, persistence-owned projection of the canonical logical session model. */
export interface RuntimeSessionGenerationView {
	readonly generationId: string;
	readonly sessionId: string;
	readonly projectId: string;
	readonly ordinal: number;
	readonly harness: Harness;
	readonly state: GenerationLifecycleState;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly fieldProvenance: Readonly<Record<string, unknown>>;
	readonly lifecycleProvenance: Readonly<Record<string, unknown>>;
	readonly parentGenerationId?: string;
	readonly continuation?: "resume";
	readonly activityAt?: string;
	readonly observedAt?: string;
	readonly endedAt?: string;
	readonly revision: number;
}

export interface RuntimeSessionView {
	readonly sessionId: string;
	readonly projectId: string;
	readonly revision: number;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly fieldProvenance: Readonly<Record<string, unknown>>;
	readonly role?: string;
	readonly activityAt?: string;
	readonly observedAt?: string;
	readonly generationIds: readonly string[];
	readonly activeGenerationId?: string;
	readonly generations: readonly RuntimeSessionGenerationView[];
}

export interface RuntimeSessionAliasInput {
	readonly projectId: string;
	readonly harness: Harness;
	readonly aliasKind: SessionAliasKind;
	readonly producerId?: string;
	readonly alias: string;
	readonly sessionId?: string;
	readonly generationId?: string;
	readonly source: string;
	readonly provenance: Readonly<Record<string, unknown>>;
}

export interface RuntimeSessionApplyInput {
	readonly signal: RuntimeSignalV1;
	readonly alias?: RuntimeSessionAliasInput;
}

export type RuntimeSessionDisposition =
	| "accepted"
	| "duplicate"
	| "ignored"
	| "rejected"
	| "review";

export interface RuntimeSessionApplyResult {
	readonly disposition: RuntimeSessionDisposition;
	readonly code: string;
	readonly sessionId?: string;
	readonly generationId?: string;
	readonly revision?: number;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeSessionCommandContext {
	readonly projectId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly expectedRevision: number;
	readonly eventId: string;
	readonly producerInstanceId: string;
	readonly harness: Harness;
	readonly sourceObservedAt: string;
	readonly receivedAt: string;
}

export interface RuntimeSessionStorage {
	apply(input: RuntimeSessionApplyInput): RuntimeSessionApplyResult;
	attachAlias(input: RuntimeSessionAliasInput): RuntimeSessionApplyResult;
	rename(
		input: RuntimeSessionCommandContext & { readonly name: string },
	): RuntimeSessionApplyResult;
	patchMetadata(
		input: RuntimeSessionCommandContext & {
			readonly metadata: Readonly<Record<string, unknown>>;
			readonly clearFields?: readonly string[];
		},
	): RuntimeSessionApplyResult;
	end(
		input: RuntimeSessionCommandContext & {
			readonly disposition: "ended" | "errored" | "superseded";
		},
	): RuntimeSessionApplyResult;
	observe(input: {
		readonly projectId: string;
		readonly sessionId: string;
		readonly generationId?: string;
		readonly observedAt: string;
	}): RuntimeSessionApplyResult;
	get(projectId: string, sessionId: string): RuntimeSessionView | undefined;
	list(projectId: string): readonly RuntimeSessionView[];
	findAlias(input: {
		readonly projectId: string;
		readonly harness: Harness;
		readonly aliasKind: SessionAliasKind;
		readonly producerId?: string;
		readonly alias: string;
	}): Readonly<{ sessionId?: string; generationId?: string }> | undefined;
}

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

export type ProjectLocationStatus = "active" | "retired" | "unregistered";
export type ProjectIdentitySource =
	| "git"
	| "marker"
	| "register"
	| "legacy_import"
	| "hook";

export interface RuntimeProjectLocationInput {
	readonly locationId: string;
	readonly canonicalPath: string;
	readonly observedPath?: string;
	readonly relation: ProjectLocationRelation;
	readonly status?: ProjectLocationStatus;
	readonly source: ProjectIdentitySource;
	readonly evidence: Readonly<Record<string, unknown>>;
	readonly observedAt: string;
}

export interface RuntimeProjectObservationInput {
	readonly projectId?: string;
	readonly name: string;
	readonly location: RuntimeProjectLocationInput;
	readonly identityKey?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly source: ProjectIdentitySource;
	readonly eventId: string;
	readonly deduplicationKey: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly provenance: Readonly<Record<string, unknown>>;
	readonly occurredAt: string;
}

export interface RuntimeProjectLocationView {
	readonly locationId: string;
	readonly canonicalPath: string;
	readonly observedPath?: string;
	readonly relation: ProjectLocationRelation;
	readonly status: ProjectLocationStatus;
	readonly lastConfirmedAt?: string;
	readonly provenance: Readonly<Record<string, unknown>>;
}

export interface RuntimeProjectView {
	readonly projectId: string;
	readonly name: string;
	readonly nameSource: ProjectIdentitySource;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly identityKeys: readonly string[];
	readonly locations: readonly RuntimeProjectLocationView[];
}

export interface RuntimeProjectObservationResult {
	readonly disposition: "accepted" | "duplicate";
	readonly projectId: string;
	readonly locationId: string;
	readonly outboxId?: string;
}

/** Runtime project identity capability; no SQLite/Kysely handle crosses it. */
export interface RuntimeProjectStorage {
	observe(
		input: RuntimeProjectObservationInput,
	): RuntimeProjectObservationResult;
	get(projectId: string): RuntimeProjectView | undefined;
	findByCanonicalPath(canonicalPath: string): RuntimeProjectView | undefined;
	findByIdentityKey(identityKey: string): RuntimeProjectView | undefined;
	attachLocation(input: {
		readonly projectId: string;
		readonly name?: string;
		readonly location: RuntimeProjectLocationInput;
		readonly identityKey?: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
		readonly source: ProjectIdentitySource;
	}): RuntimeProjectView;
	retireLocation(
		projectId: string,
		locationId: string,
		reason: string,
	): RuntimeProjectView;
	rename(
		projectId: string,
		name: string,
		source?: ProjectIdentitySource,
	): RuntimeProjectView;
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

/**
 * GOL-35 tracker-core rows are distinct from durable delivery. They remain on
 * the persistence boundary so UI, CLI, MCP, and adapters cannot open a SQLite
 * handle or instantiate a repository.
 */
export type TrackerCoreWorkItemKind =
	| "spec"
	| "work-item"
	| "question"
	| "decision"
	| "fix";
/** Existing tracker priority vocabulary is intentionally preserved verbatim. */
export type TrackerCorePriority = "P0" | "P1" | "P2" | "P3" | null;
export type TrackerCoreState =
	| "todo"
	| "in_progress"
	| "blocked"
	| "review"
	| "done"
	| "archived";
export type TrackerCoreLinkRelation = "blocks" | "relates" | "duplicates";
export type TrackerCoreResourceType = "ticket" | "comment" | "link" | "stream";

export interface TrackerCoreRuntimeReference {
	readonly projectId: string;
	readonly sessionId?: string;
	readonly generationId?: string;
}

export interface TrackerCoreWorkItem {
	readonly id: string;
	readonly displayId: string;
	readonly projectId: string;
	readonly kind: TrackerCoreWorkItemKind;
	readonly title: string;
	readonly body: string;
	readonly priority: TrackerCorePriority;
	readonly labels: readonly string[];
	readonly streamId?: string;
	readonly parentId?: string;
	readonly assignee?: string;
	readonly dispatchedTo?: string;
	readonly dispatchedAt?: string;
	readonly state: TrackerCoreState;
	readonly phase: string;
	readonly rank: number;
	readonly wave?: number;
	readonly runtimeReference?: TrackerCoreRuntimeReference;
	readonly revision: number;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TrackerCorePhaseEvidence {
	readonly closingBrief: boolean;
	readonly verificationReport: boolean;
	readonly answerComment: boolean;
	readonly decisionComment: boolean;
	readonly reason: boolean;
	readonly groundingSummary: boolean;
	readonly design: boolean;
	readonly concerns: boolean;
	readonly humanFinalise: boolean;
	readonly children: boolean;
	readonly childrenTerminal: boolean;
	readonly waves: boolean;
	readonly childStarted: boolean;
	readonly managerDispatch: boolean;
	/** A manager-authored durable authorization for an exceptional skip. */
	readonly managerSkip: boolean;
}

export interface TrackerCoreComment {
	readonly id: string;
	readonly ticketId: string;
	readonly parentId?: string;
	readonly author: string;
	readonly body: string;
	readonly anchor?: Readonly<Record<string, unknown>>;
	readonly tag: string;
	readonly status: string;
	readonly dispatchState: string;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TrackerCoreLink {
	readonly id: string;
	readonly ticketId: string;
	readonly targetTicketId: string;
	readonly relation: TrackerCoreLinkRelation;
	readonly actor: string;
	readonly createdAt: string;
}

export interface TrackerCoreStream {
	readonly id: string;
	readonly projectId: string;
	readonly name: string;
	readonly mode: "sequential" | "parallel";
	readonly description: string;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TrackerCoreAuditRecord {
	readonly id: string;
	readonly actor: string;
	readonly action: string;
	readonly resourceType: TrackerCoreResourceType;
	readonly resourceId: string;
	readonly revision: number;
	readonly details: Readonly<Record<string, unknown>>;
	readonly createdAt: string;
}

export interface TrackerCoreMutationMetadata {
	readonly actor: string;
	readonly eventId: string;
	readonly outboxId: string;
	readonly auditId: string;
	readonly now: string;
}

/**
 * Trusted authority supplied by the authenticated dashboard/MCP composition
 * boundary. Request-body actor strings are deliberately not this type and
 * cannot authorize an exceptional close.
 */
export interface TrackerCoreActorContext {
	readonly actor: string;
	readonly role: "human" | "manager";
	readonly authenticated: true;
	readonly source: "dashboard" | "mcp" | "journey";
}

export interface TrackerCoreExceptionalClose {
	readonly reason: string;
	readonly actorContext: TrackerCoreActorContext;
}

export interface TrackerCoreStorageCapability {
	allocateDisplayId(prefix: "GOL" | "TKT"): string;
	createWorkItem(input: {
		readonly workItem: TrackerCoreWorkItem;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreWorkItem;
	getWorkItem(id: string): TrackerCoreWorkItem | undefined;
	phaseEvidence(id: string): TrackerCorePhaseEvidence;
	listWorkItems(input?: {
		readonly projectId?: string;
		readonly kind?: TrackerCoreWorkItemKind;
		readonly phase?: string;
		readonly assignee?: string;
	}): readonly TrackerCoreWorkItem[];
	searchWorkItems(
		query: string,
		projectId?: string,
	): readonly TrackerCoreWorkItem[];
	updateWorkItem(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly patch: Partial<
			Pick<
				TrackerCoreWorkItem,
				| "kind"
				| "state"
				| "phase"
				| "title"
				| "body"
				| "priority"
				| "labels"
				| "streamId"
				| "parentId"
				| "assignee"
				| "rank"
				| "wave"
				| "runtimeReference"
			>
		>;
		readonly mutation: TrackerCoreMutationMetadata;
		readonly exceptionalClose?: TrackerCoreExceptionalClose;
	}): TrackerCoreWorkItem | undefined;
	transitionWorkItem(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly phase: string;
		readonly state: TrackerCoreState;
		readonly artifacts: Readonly<Record<string, unknown>>;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreWorkItem | undefined;
	createComment(input: {
		readonly comment: TrackerCoreComment;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreComment;
	updateComment(input: {
		readonly ticketId: string;
		readonly commentId: string;
		readonly patch: Partial<
			Pick<TrackerCoreComment, "body" | "tag" | "status" | "dispatchState">
		>;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreComment | undefined;
	getComment(id: string): TrackerCoreComment | undefined;
	listComments(ticketId: string): readonly TrackerCoreComment[];
	createLink(input: {
		readonly link: TrackerCoreLink;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreLink;
	deleteLink(input: {
		readonly ticketId: string;
		readonly targetTicketId: string;
		readonly relation: TrackerCoreLinkRelation;
		readonly mutation: TrackerCoreMutationMetadata;
	}): boolean;
	listLinks(ticketId: string): readonly TrackerCoreLink[];
	upsertStream(input: {
		readonly stream: TrackerCoreStream;
		readonly expectedRevision?: number;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreStream | undefined;
	listStreams(projectId?: string): readonly TrackerCoreStream[];
	auditCore(): readonly TrackerCoreAuditRecord[];
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
	/** Typed project/location identity capability owned by the runtime DB owner. */
	runtimeProjectStorage(): RuntimeProjectStorage;
	/** Typed logical session/generation/alias projection owned by the runtime DB owner. */
	runtimeSessionStorage(): RuntimeSessionStorage;
	/** Typed tracker store; no raw connection leaves the single owner. */
	trackerStorage(): TrackerStorageCapability;
	/** Typed work-item/phase repository capability for @golem/tracker only. */
	trackerCoreStorage(): TrackerCoreStorageCapability;
	status(): PersistenceStatus;
	close(): Promise<void>;
}
