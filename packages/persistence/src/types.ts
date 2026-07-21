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

export type EndpointRouteKind = "control" | "delivery" | "observation";
export type EndpointControlState = "enabled" | "held" | "disabled";

export interface RuntimeEndpointCapability {
	readonly capability: string;
	readonly adapterId: string;
	readonly adapterVersion: string;
	readonly qualification: CapabilityQualification;
	readonly deliveryMode: DeliveryMode;
	readonly readiness: EndpointReadinessState;
	readonly evidenceKind: "probe" | "configured" | "observed" | "operator";
	readonly observedAt: string;
	readonly expiresAt?: string;
}

export interface RuntimeEndpointView {
	readonly endpointId: string;
	readonly generationId: string;
	readonly routeKind: EndpointRouteKind;
	readonly revision: number;
	readonly state: EndpointLifecycleState;
	readonly ownerFence: number;
	readonly ownerInstanceId: string;
	readonly deliveryMode: DeliveryMode;
	readonly readiness: EndpointReadinessState;
	readonly controlState: EndpointControlState;
	readonly consumerReady: boolean;
	readonly consumptionObserved: boolean;
	readonly deliveryObserved: boolean;
	readonly deliveryFailed: boolean;
	readonly claimedAt: string;
	readonly heartbeatAt?: string;
	readonly expiresAt?: string;
	readonly supersededAt?: string;
	readonly capabilities: readonly RuntimeEndpointCapability[];
}

export interface RuntimeEndpointMutationResult {
	readonly disposition: "accepted" | "rejected" | "ignored";
	readonly code: string;
	readonly endpointId?: string;
	readonly revision?: number;
	readonly ownerFence?: number;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeEndpointEligibility {
	readonly disposition: "eligible" | "ineligible";
	readonly code: string;
	readonly remedy: string;
	readonly endpoint?: RuntimeEndpointView;
	readonly capability?: RuntimeEndpointCapability;
	readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export interface RuntimeEndpointStorage {
	claim(input: {
		readonly endpointId?: string;
		readonly generationId: string;
		readonly routeKind: EndpointRouteKind;
		readonly ownerInstanceId: string;
		readonly deliveryMode: DeliveryMode;
		readonly readiness?: EndpointReadinessState;
		readonly controlState?: EndpointControlState;
		readonly leaseMs: number;
	}): RuntimeEndpointMutationResult;
	heartbeat(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
		readonly heartbeatAt?: string;
		readonly leaseMs: number;
	}): RuntimeEndpointMutationResult;
	reportHealth(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
		readonly state: "healthy" | "degraded";
	}): RuntimeEndpointMutationResult;
	reportReadiness(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
		readonly deliveryMode: DeliveryMode;
		readonly readiness: EndpointReadinessState;
		readonly controlState?: EndpointControlState;
	}): RuntimeEndpointMutationResult;
	probe(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
		readonly consumerReady: boolean;
		readonly readiness?: EndpointReadinessState;
	}): RuntimeEndpointMutationResult;
	reportDelivery(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
		readonly status: "accepted" | "delivered" | "failed";
		readonly readiness?: EndpointReadinessState;
	}): RuntimeEndpointMutationResult;
	reportCapability(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
		readonly capability: RuntimeEndpointCapability;
		readonly evidence: Readonly<Record<string, unknown>>;
	}): RuntimeEndpointMutationResult;
	release(input: {
		readonly endpointId: string;
		readonly generationId: string;
		readonly ownerInstanceId: string;
		readonly ownerFence: number;
	}): RuntimeEndpointMutationResult;
	expire(now?: string): readonly RuntimeEndpointMutationResult[];
	eligibility(input: {
		readonly generationId: string;
		readonly routeKind: EndpointRouteKind;
		readonly requiredCapability?: string;
		/** Fence captured when work was queued; stale queued delivery fails closed. */
		readonly expectedOwnerFence?: number;
		/** Compatibility spelling for callers that persist a queued fence. */
		readonly expectedFence?: number;
		readonly now?: string;
	}): RuntimeEndpointEligibility;
	get(endpointId: string): RuntimeEndpointView | undefined;
	list(generationId: string): readonly RuntimeEndpointView[];
}

/**
 * Read-only runtime projection facts.  The owner keeps the SQLite connection
 * private; runtime/control-plane consumers receive bounded typed rows only.
 */
export interface RuntimeEventRecord {
	readonly eventId: string;
	readonly eventKind: string;
	readonly payload: TrackerJsonObject;
	readonly provenance: TrackerJsonObject;
	readonly sourceObservedAt: string;
	readonly receivedAt: string;
	readonly materializedAt: string;
	readonly disposition:
		| "accepted"
		| "duplicate"
		| "stale"
		| "illegal"
		| "quarantined";
}

export interface RuntimeDiagnosticRecord {
	readonly id: string;
	readonly code: string;
	readonly details: TrackerJsonObject;
	readonly createdAt: string;
}

export interface RuntimeWatermarkRecord {
	readonly producerId: string;
	readonly watermark: string;
	readonly sourceObservedAt: string;
	readonly receivedAt: string;
	readonly materializedAt: string;
}

export interface RuntimeProjectionStorage {
	projects(): readonly RuntimeProjectView[];
	sessions(projectId?: string): readonly RuntimeSessionView[];
	endpoints(generationId?: string): readonly RuntimeEndpointView[];
	events(): readonly RuntimeEventRecord[];
	diagnostics(): readonly RuntimeDiagnosticRecord[];
	watermarks(): readonly RuntimeWatermarkRecord[];
	revision(): number;
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

/** Typed management records. They reference canonical project/session/ticket IDs but never own runtime lifecycle. */
export type ManagementRoleScope = "project" | "session" | "generation";
export type ManagementGateKind = "approval" | "input";
export type ManagementGateStatus =
	| "awaiting"
	| "approved"
	| "denied"
	| "cancelled";
export type ManagementIdeaStatus = "pending" | "popped" | "promoted";
export type ManagementOperationStatus = "queued" | "ineligible" | "delivered";
export type ManagementCommunicationKind =
	| "chat"
	| "brief"
	| "interrupt"
	| "halt"
	| "control";

export interface TrackerManagementRole {
	readonly id: string;
	readonly projectId: string;
	readonly name: string;
	readonly scope: ManagementRoleScope;
	readonly definition: TrackerJsonObject;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}
export interface TrackerManagementAssignment {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly generationId?: string;
	readonly roleId: string;
	readonly actor: string;
	readonly idempotencyKey: string;
	readonly createdAt: string;
}
export interface TrackerManagementGate {
	readonly id: string;
	readonly projectId: string;
	readonly kind: ManagementGateKind;
	readonly status: ManagementGateStatus;
	readonly question: string;
	readonly assignee: string;
	readonly verdict?: TrackerJsonObject;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}
export interface TrackerManagementIdea {
	readonly id: string;
	readonly projectId: string;
	readonly body: string;
	readonly status: ManagementIdeaStatus;
	readonly promotedTicketId?: string;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}
export interface TrackerManagementAsset {
	readonly id: string;
	readonly projectId: string;
	readonly ticketId: string;
	readonly relativePath: string;
	readonly mimeType: string;
	readonly byteSize: number;
	readonly sha256: string;
	readonly storagePath: string;
	readonly createdAt: string;
}
export interface TrackerManagementOperation {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly generationId?: string;
	readonly kind: ManagementCommunicationKind;
	readonly command: string;
	readonly payload: TrackerJsonObject;
	readonly status: ManagementOperationStatus;
	readonly actor: string;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}
export interface TrackerManagementAuditRecord {
	readonly id: string;
	readonly projectId: string;
	readonly kind: string;
	readonly subjectId: string;
	readonly actor: string;
	readonly details: TrackerJsonObject;
	readonly createdAt: string;
}

/** Owner-backed management capability; no raw SQLite/Kysely handle crosses the boundary. */
export interface TrackerManagementStorageCapability {
	createRole(
		input: Omit<
			TrackerManagementRole,
			"revision" | "createdAt" | "updatedAt"
		> & { readonly actor: string; readonly now: string },
	): TrackerManagementRole;
	listRoles(projectId: string): readonly TrackerManagementRole[];
	assignRole(
		input: Omit<TrackerManagementAssignment, "createdAt"> & {
			readonly now: string;
		},
	): TrackerManagementAssignment;
	createGate(
		input: Omit<TrackerManagementGate, "createdAt" | "updatedAt" | "status"> & {
			readonly actor: string;
			readonly now: string;
		},
	): TrackerManagementGate;
	answerGate(input: {
		readonly id: string;
		readonly projectId: string;
		readonly status: Exclude<ManagementGateStatus, "awaiting">;
		readonly verdict: TrackerJsonObject;
		readonly actor: string;
		readonly now: string;
	}): TrackerManagementGate | undefined;
	listGates(projectId: string): readonly TrackerManagementGate[];
	createIdea(
		input: Omit<TrackerManagementIdea, "createdAt" | "updatedAt" | "status"> & {
			readonly actor: string;
			readonly now: string;
		},
	): TrackerManagementIdea;
	popIdea(input: {
		readonly id: string;
		readonly projectId: string;
		readonly actor: string;
		readonly now: string;
	}): TrackerManagementIdea | undefined;
	promoteIdea(input: {
		readonly id: string;
		readonly projectId: string;
		readonly ticketId: string;
		readonly actor: string;
		readonly now: string;
	}): TrackerManagementIdea | undefined;
	listIdeas(projectId: string): readonly TrackerManagementIdea[];
	putAsset(
		input: Omit<TrackerManagementAsset, "createdAt"> & {
			readonly actor: string;
			readonly now: string;
		},
	): TrackerManagementAsset;
	getAsset(input: {
		readonly id: string;
		readonly projectId: string;
		readonly ticketId: string;
	}): TrackerManagementAsset | undefined;
	createOperation(
		input: Omit<
			TrackerManagementOperation,
			"createdAt" | "updatedAt" | "status"
		> & { readonly now: string },
	): TrackerManagementOperation;
	getOperation(
		id: string,
		projectId: string,
	): TrackerManagementOperation | undefined;
	listOperations(projectId: string): readonly TrackerManagementOperation[];
	auditManagement(projectId: string): readonly TrackerManagementAuditRecord[];
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
	/** Typed endpoint fencing/readiness capability owned by the runtime DB owner. */
	runtimeEndpointStorage(): RuntimeEndpointStorage;
	/** Read-only runtime projection facts; no SQLite handle crosses the owner. */
	runtimeProjectionStorage(): RuntimeProjectionStorage;
	/** Typed tracker store; no raw connection leaves the single owner. */
	trackerStorage(): TrackerStorageCapability;
	/** Typed work-item/phase repository capability for @golem/tracker only. */
	trackerCoreStorage(): TrackerCoreStorageCapability;
	/** Typed management records owned by the same tracker SQLite owner. */
	managementStorage(): TrackerManagementStorageCapability;
	status(): PersistenceStatus;
	close(): Promise<void>;
}
