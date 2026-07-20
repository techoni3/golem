import type {
	AliasReference,
	DeliveryMode,
	DeliveryReadiness,
	EndpointRouteState,
	LifecycleState,
	RuntimeSignalV1,
} from "@golem/contracts";

export type EndpointFact = Extract<
	RuntimeSignalV1["payload"],
	{ kind: "endpoint.claimed" }
>["endpoint"];
export type CapabilityFact = Extract<
	RuntimeSignalV1["payload"],
	{ kind: "capabilities.reported" }
>["capabilities"][number];

export type ExplanationCode =
	| "domain.alias.ambiguous"
	| "domain.alias.attached"
	| "domain.alias.duplicate"
	| "domain.alias.invalid"
	| "domain.alias.unresolved"
	| "domain.capability.qualified"
	| "domain.endpoint.fence_stale"
	| "domain.endpoint.unknown"
	| "domain.event.applied"
	| "domain.event.duplicate"
	| "domain.lifecycle.duplicate"
	| "domain.lifecycle.regression"
	| "domain.lifecycle.terminal"
	| "domain.ordering.field_stale"
	| "domain.ordering.stale_sequence"
	| "domain.ordering.tie_lost"
	| "domain.projection.history_terminal"
	| "domain.projection.live"
	| "domain.projection.no_active_generation"
	| "domain.signal.unsupported";

export type Disposition = "applied" | "ignored" | "rejected" | "review";

export interface DomainExplanation {
	readonly code: ExplanationCode;
	readonly severity: "info" | "warning" | "error";
	readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export interface DomainEffect {
	readonly disposition: Disposition;
	readonly explanation: DomainExplanation;
}

export interface ReducerClock {
	readonly materializedAt: string;
}

export interface ProjectLocation {
	readonly locationId: string;
	readonly canonicalPath: string;
	readonly observedPath?: string;
	readonly relation: "main" | "worktree" | "registered" | "legacy";
	readonly provenance: FieldProvenance;
}

export interface ProjectRecord {
	readonly projectId: string;
	readonly locations: Readonly<Record<string, ProjectLocation>>;
}

/** Source time followed by a stable event/producer tie break; receipt time never wins. */
export interface FieldProvenance {
	readonly eventId: string;
	readonly producerInstanceId: string;
	readonly sourceTime: string;
	readonly tieBreak: string;
}

export interface GenerationClocks {
	readonly startedAt: string;
	readonly resumedAt?: string;
	readonly lastActivityAt?: string;
	readonly metadataUpdatedAt?: string;
	readonly lastSourceObservedAt: string;
	readonly receivedAt: string;
	readonly materializedAt: string;
	readonly endedAt?: string;
}

export interface GenerationRecord {
	readonly generationId: string;
	readonly sessionId: string;
	readonly projectId: string;
	readonly state: LifecycleState;
	/** Immutable creation facts use a separate winner from lifecycle transitions. */
	readonly creationProvenance: FieldProvenance;
	/** Lifecycle is versioned like metadata: an older terminal fact cannot win later. */
	readonly lifecycleProvenance: FieldProvenance;
	/** Activity is independent from operational lifecycle labels. */
	readonly activityProvenance?: FieldProvenance;
	readonly clocks: GenerationClocks;
	readonly metadata: Readonly<Record<string, unknown>>;
	/** Retained for cleared fields so a delayed set cannot recreate them. */
	readonly fieldProvenance: Readonly<Record<string, FieldProvenance>>;
}

export interface SessionRecord {
	readonly sessionId: string;
	readonly projectId: string;
	readonly generationIds: readonly string[];
	readonly activeGenerationId?: string;
}

/**
 * Camel-cased domain view of the canonical GOL-26 alias reference.  Keep this
 * derived rather than locally widening the public alias vocabulary.
 */
export type ScopedAlias = Readonly<{
	readonly projectId: AliasReference["project_id"];
	readonly harness: AliasReference["harness"];
	readonly kind: AliasReference["alias_kind"];
	readonly value: AliasReference["alias"];
	readonly producerId?: NonNullable<AliasReference["producer_id"]>;
	/** Omitted session evidence is review-only; it can never create a link. */
	readonly sessionId?: NonNullable<AliasReference["session"]>["session_id"];
}>;

/** Unresolved evidence is never a state alias; stored aliases are attached only. */
export type ResolvedScopedAlias = ScopedAlias &
	Readonly<{
		readonly sessionId: NonNullable<AliasReference["session"]>["session_id"];
	}>;

export interface EndpointClaim {
	readonly endpointId: string;
	readonly generationId: string;
	readonly ownerFence: string;
	readonly revision: number;
	readonly state: EndpointRouteState;
	readonly deliveryMode: DeliveryMode;
	readonly readiness: DeliveryReadiness;
	readonly lastHeartbeatAt?: string;
	/** Revision/fence wins first; source-time provenance resolves equal owners. */
	readonly claimProvenance: FieldProvenance;
	readonly stateProvenance: FieldProvenance;
	readonly heartbeatProvenance?: FieldProvenance;
}

export interface CapabilityRecord {
	readonly capability: CapabilityFact;
	readonly provenance: FieldProvenance;
}

export interface Watermark {
	readonly sequence: number;
	readonly orderKey: string;
}

export interface DomainState {
	readonly projects: Readonly<Record<string, ProjectRecord>>;
	readonly sessions: Readonly<Record<string, SessionRecord>>;
	readonly generations: Readonly<Record<string, GenerationRecord>>;
	readonly aliases: Readonly<Record<string, ResolvedScopedAlias>>;
	readonly endpoints: Readonly<Record<string, EndpointClaim>>;
	readonly capabilities: Readonly<Record<string, CapabilityRecord>>;
	readonly seenEventIds: Readonly<Record<string, true>>;
	readonly watermarks: Readonly<Record<string, Watermark>>;
}

export interface ReducerResult {
	readonly state: DomainState;
	readonly effect: DomainEffect;
}

export function emptyDomainState(): DomainState {
	return {
		projects: {},
		sessions: {},
		generations: {},
		aliases: {},
		endpoints: {},
		capabilities: {},
		seenEventIds: {},
		watermarks: {},
	};
}

/** Object-key ordering is part of canonical replay serialization. */
export function orderedRecord<T>(
	record: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
	return Object.fromEntries(
		Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
	);
}
