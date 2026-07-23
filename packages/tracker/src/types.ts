/**
 * Durable delivery is deliberately expressed through typed ports.  The tracker
 * never reads a harness JSON registry: control-plane composition supplies the
 * current endpoint eligibility and the persistence owner supplies storage.
 */
export type JsonObject = Readonly<Record<string, unknown>>;

export type DeliveryReadiness =
	| "ready"
	| "held_busy"
	| "held_waiting"
	| "pull_only"
	| "next_turn"
	| "unsupported"
	| "unhealthy"
	| "uninitialized";

export type DeliveryMode =
	| "pull"
	| "native_channel"
	| "prompt_bridge"
	| "managed_app_server"
	| "next_turn";

export type CapabilityQualification =
	| "supported"
	| "experimental"
	| "unsupported"
	| "unknown";

export interface DeliveryCapabilityEvidence {
	readonly capability: string;
	readonly qualification: CapabilityQualification;
	readonly observedAt: string;
}

/** The complete canonical endpoint fact required to deliver an envelope. */
export interface DeliveryEligibility {
	readonly recipientId: string;
	readonly generationId: string;
	readonly endpointId: string;
	readonly ownerFence: number;
	readonly readiness: DeliveryReadiness;
	readonly mode: DeliveryMode;
	readonly capabilities: readonly DeliveryCapabilityEvidence[];
}

/**
 * Injected by control-plane composition. It is intentionally not a registry
 * path or a JSON record: callers must provide a canonical endpoint snapshot.
 */
export interface DeliveryEligibilityPort {
	resolve(recipientId: string): DeliveryEligibility | undefined;
}

export interface TrackerClock {
	now(): string;
	after(milliseconds: number): string;
}

export interface CreateEnvelopeInput {
	readonly id: string;
	/** Resolver/API composed scope. Direct legacy callers become system-scoped. */
	readonly projectId?: string;
	readonly idempotencyKey: string;
	readonly senderId: string;
	readonly recipientId: string;
	readonly kind: string;
	readonly payload: JsonObject;
	readonly deadlineAt?: string;
	readonly maxAttempts?: number;
	readonly replyToRecipientId?: string;
}

export interface DeliveryEnvelope {
	readonly id: string;
	readonly projectId: string;
	readonly rootId: string;
	readonly parentId?: string;
	readonly idempotencyKey: string;
	readonly senderId: string;
	readonly recipientId: string;
	readonly replyToRecipientId?: string;
	readonly kind: string;
	readonly payload: JsonObject;
	readonly endpoint: DeliveryEligibility;
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

export interface ClaimedDeliveryEnvelope extends DeliveryEnvelope {
	readonly claimToken: string;
	readonly claimOwner: string;
	readonly claimUntil: string;
}

export interface EnvelopeClaim {
	readonly envelope: ClaimedDeliveryEnvelope;
	/** Rechecks eligibility immediately before the transport boundary. */
	prepare():
		| { readonly kind: "deliver"; readonly envelope: ClaimedDeliveryEnvelope }
		| {
				readonly kind: "stale";
				readonly reason: "endpoint_changed" | "ineligible";
		  };
	acknowledge(acknowledgementId: string, payload?: JsonObject): boolean;
	reply(input: {
		readonly id: string;
		readonly idempotencyKey: string;
		readonly payload: JsonObject;
	}): DeliveryEnvelope;
	fail(error: string, retryAfterMs?: number): DeliveryEnvelope;
	delivered(): DeliveryEnvelope;
}

export interface BusEvent {
	readonly sequence: number;
	readonly projectId: string;
	readonly id: string;
	readonly deduplicationKey: string;
	readonly topic: string;
	readonly class: "tracker" | "lifecycle" | "custom";
	readonly payload: JsonObject;
	readonly createdAt: string;
}

export interface Subscription {
	readonly id: string;
	readonly name: string;
	readonly recipientId: string;
	readonly topic: string;
	readonly classes: readonly BusEvent["class"][];
	readonly cursor: number;
	readonly manual: boolean;
	readonly status: "active" | "offline" | "suspended";
	readonly createdAt: string;
}

export interface PendingSubscriptionEvents {
	readonly subscription: Subscription;
	readonly events: readonly BusEvent[];
	readonly fromSequence: number;
	readonly toSequence: number;
}

export interface PassiveDelta {
	readonly recipientId: string;
	readonly ticketId: string;
	readonly category: string;
	readonly baseline: JsonObject;
	readonly value: JsonObject;
	readonly eventId: string;
}

export interface ClaimedPassiveBatch {
	readonly recipientId: string;
	readonly leaseId: string;
	readonly leaseUntil: string;
	readonly cursor: number;
	readonly body: string;
	readonly entries: readonly PassiveDelta[];
}

/** Stable result used instead of silently accepting conflicting idempotency. */
export type CreateEnvelopeResult =
	| { readonly kind: "created"; readonly envelope: DeliveryEnvelope }
	| { readonly kind: "duplicate"; readonly envelope: DeliveryEnvelope }
	| { readonly kind: "conflict"; readonly reason: "id" | "idempotency_key" };

export type AppendBusEventResult =
	| { readonly kind: "created"; readonly event: BusEvent }
	| { readonly kind: "duplicate"; readonly event: BusEvent }
	| { readonly kind: "conflict"; readonly reason: "id" | "deduplication_key" };

/**
 * The storage capability implemented by the single SQLite owner. It contains
 * no raw database handle and is safe to hand to the tracker service layer.
 */
export interface TrackerStoragePort {
	createEnvelope(input: {
		readonly envelope: DeliveryEnvelope;
		readonly fingerprint: string;
	}): CreateEnvelopeResult;
	claimEnvelopes(input: {
		readonly workerId: string;
		readonly now: string;
		readonly claimUntil: string;
		readonly limit: number;
	}): readonly ClaimedDeliveryEnvelope[];
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
	}): DeliveryEnvelope | undefined;
	acknowledgeEnvelope(input: {
		readonly id: string;
		readonly claimToken: string;
		readonly acknowledgementId: string;
		readonly recipientId: string;
		readonly payload: JsonObject;
		readonly now: string;
	}): boolean;
	createReplyEnvelope(input: {
		readonly parentId: string;
		readonly claimToken: string;
		readonly envelope: DeliveryEnvelope;
		readonly fingerprint: string;
	}): CreateEnvelopeResult;
	recoverEnvelopes(now: string): readonly DeliveryEnvelope[];
	appendBusEvent(input: {
		readonly event: Omit<BusEvent, "sequence">;
		readonly fingerprint: string;
	}): AppendBusEventResult;
	upsertSubscription(input: Subscription): Subscription;
	pendingSubscriptionEvents(input: {
		readonly id: string;
		readonly limit: number;
	}): PendingSubscriptionEvents | undefined;
	advanceSubscriptionCursor(input: {
		readonly id: string;
		readonly fromSequence: number;
		readonly toSequence: number;
	}): boolean;
	upsertPassiveDelta(input: PassiveDelta & { readonly now: string }): void;
	claimPassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly leaseUntil: string;
		readonly now: string;
	}): ClaimedPassiveBatch | undefined;
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
		readonly details: JsonObject;
		readonly createdAt: string;
	}[];
}

export class EnvelopeConflictError extends Error {
	constructor(readonly reason: "id" | "idempotency_key") {
		super(`delivery envelope conflicts with an existing ${reason}`);
		this.name = "EnvelopeConflictError";
	}
}

export class BusEventConflictError extends Error {
	constructor(readonly reason: "id" | "deduplication_key") {
		super(`bus event conflicts with an existing ${reason}`);
		this.name = "BusEventConflictError";
	}
}
