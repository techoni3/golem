import {
	type ClaimedDeliveryEnvelope,
	type CreateEnvelopeInput,
	type DeliveryEligibility,
	type DeliveryEligibilityPort,
	type DeliveryEnvelope,
	type EnvelopeClaim,
	EnvelopeConflictError,
	type JsonObject,
	type TrackerClock,
	type TrackerStoragePort,
} from "./types.js";
import {
	requireClaimLimit,
	requireDeadline,
	requireIdentifier,
	requireJsonObject,
	requireLease,
	requireMaxAttempts,
	requireRetryDelay,
	sanitizeDiagnostic,
} from "./validation.js";

const defaultLeaseMs = 30_000;
const defaultMaxAttempts = 5;

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}

function cloneEndpoint(endpoint: DeliveryEligibility): DeliveryEligibility {
	return Object.freeze({
		...endpoint,
		capabilities: Object.freeze(
			endpoint.capabilities.map((capability) => ({ ...capability })),
		),
	});
}

function eligible(
	endpoint: DeliveryEligibility | undefined,
): endpoint is DeliveryEligibility {
	if (endpoint?.readiness !== "ready") return false;
	return endpoint.capabilities.some(
		(capability) =>
			capability.capability === "delivery" &&
			(capability.qualification === "supported" ||
				capability.qualification === "experimental"),
	);
}

function endpointMatches(
	stored: DeliveryEligibility,
	current: DeliveryEligibility | undefined,
): boolean {
	return Boolean(
		current &&
			current.endpointId === stored.endpointId &&
			current.generationId === stored.generationId &&
			current.ownerFence === stored.ownerFence &&
			eligible(current),
	);
}

function retryAfter(attempts: number): number {
	return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

export interface DurableDeliveryService {
	enqueue(input: CreateEnvelopeInput): DeliveryEnvelope;
	claim(
		workerId: string,
		limit?: number,
		leaseMs?: number,
	): readonly EnvelopeClaim[];
	recover(): readonly DeliveryEnvelope[];
}

export function createDurableDeliveryService(options: {
	readonly storage: TrackerStoragePort;
	readonly eligibility: DeliveryEligibilityPort;
	readonly clock: TrackerClock;
}): DurableDeliveryService {
	function enqueue(input: CreateEnvelopeInput): DeliveryEnvelope {
		requireIdentifier(input.id, "delivery id");
		requireIdentifier(input.idempotencyKey, "delivery idempotency key");
		requireIdentifier(input.senderId, "delivery sender");
		requireIdentifier(input.recipientId, "delivery recipient");
		requireIdentifier(input.kind, "delivery kind");
		if (input.replyToRecipientId !== undefined)
			requireIdentifier(input.replyToRecipientId, "delivery reply recipient");
		requireJsonObject(input.payload, "delivery payload");
		const endpoint = options.eligibility.resolve(input.recipientId);
		if (!eligible(endpoint))
			throw new Error("delivery endpoint is not eligible for a new envelope");
		const maxAttempts = input.maxAttempts ?? defaultMaxAttempts;
		requireMaxAttempts(maxAttempts);
		if (input.deadlineAt !== undefined)
			requireDeadline(input.deadlineAt, options.clock);
		const now = options.clock.now();
		const envelope: DeliveryEnvelope = Object.freeze({
			id: input.id,
			projectId: input.projectId ?? "system",
			rootId: input.id,
			idempotencyKey: input.idempotencyKey,
			senderId: input.senderId,
			recipientId: input.recipientId,
			...(input.replyToRecipientId
				? { replyToRecipientId: input.replyToRecipientId }
				: {}),
			kind: input.kind,
			payload: Object.freeze({ ...input.payload }),
			endpoint: cloneEndpoint(endpoint),
			status: "pending",
			attempts: 0,
			maxAttempts,
			...(input.deadlineAt !== undefined
				? { deadlineAt: input.deadlineAt }
				: {}),
			createdAt: now,
		});
		const result = options.storage.createEnvelope({
			envelope,
			fingerprint: canonicalJson({
				idempotencyKey: input.idempotencyKey,
				senderId: input.senderId,
				recipientId: input.recipientId,
				kind: input.kind,
				payload: input.payload,
				deadlineAt: input.deadlineAt ?? null,
				maxAttempts,
				replyToRecipientId: input.replyToRecipientId ?? null,
			}),
		});
		if (result.kind === "conflict")
			throw new EnvelopeConflictError(result.reason);
		return result.envelope;
	}

	function wrapClaim(envelope: ClaimedDeliveryEnvelope): EnvelopeClaim {
		let prepared = false;
		const requirePrepared = (): void => {
			if (!prepared)
				throw new Error("delivery claim requires successful current prepare");
		};
		const settle = (
			status: "pending" | "delivered" | "retrying" | "dead_letter" | "expired",
			error?: string,
			nextAttemptAt?: string,
		): DeliveryEnvelope => {
			const settled = options.storage.settleEnvelope({
				id: envelope.id,
				claimToken: envelope.claimToken,
				now: options.clock.now(),
				status,
				...(error ? { error } : {}),
				...(nextAttemptAt ? { nextAttemptAt } : {}),
			});
			if (!settled) throw new Error("delivery claim is no longer current");
			return settled;
		};
		return Object.freeze({
			envelope,
			prepare() {
				const current = options.eligibility.resolve(envelope.recipientId);
				if (endpointMatches(envelope.endpoint, current)) {
					prepared = true;
					return Object.freeze({ kind: "deliver" as const, envelope });
				}
				prepared = false;
				settle(
					"retrying",
					"endpoint eligibility changed",
					options.clock.after(1_000),
				);
				return Object.freeze({
					kind: "stale" as const,
					reason: current
						? ("endpoint_changed" as const)
						: ("ineligible" as const),
				});
			},
			acknowledge(acknowledgementId: string, payload: JsonObject = {}) {
				requirePrepared();
				requireIdentifier(acknowledgementId, "acknowledgement id");
				requireJsonObject(payload, "acknowledgement payload");
				return options.storage.acknowledgeEnvelope({
					id: envelope.id,
					claimToken: envelope.claimToken,
					acknowledgementId,
					recipientId: envelope.recipientId,
					payload,
					now: options.clock.now(),
				});
			},
			reply(input: {
				readonly id: string;
				readonly idempotencyKey: string;
				readonly payload: JsonObject;
			}) {
				requirePrepared();
				requireIdentifier(input.id, "reply id");
				requireIdentifier(input.idempotencyKey, "reply idempotency key");
				requireJsonObject(input.payload, "reply payload");
				if (!envelope.replyToRecipientId)
					throw new Error("delivery envelope has no reply route");
				const endpoint = options.eligibility.resolve(
					envelope.replyToRecipientId,
				);
				if (!eligible(endpoint))
					throw new Error("reply endpoint is not eligible");
				const child: DeliveryEnvelope = Object.freeze({
					id: input.id,
					projectId: envelope.projectId,
					rootId: envelope.rootId,
					parentId: envelope.id,
					idempotencyKey: input.idempotencyKey,
					senderId: envelope.recipientId,
					recipientId: envelope.replyToRecipientId,
					replyToRecipientId: envelope.recipientId,
					kind: "reply",
					payload: Object.freeze({ ...input.payload }),
					endpoint: cloneEndpoint(endpoint),
					status: "pending",
					attempts: 0,
					maxAttempts: envelope.maxAttempts,
					createdAt: options.clock.now(),
				});
				const result = options.storage.createReplyEnvelope({
					parentId: envelope.id,
					claimToken: envelope.claimToken,
					envelope: child,
					fingerprint: canonicalJson({
						parentId: envelope.id,
						idempotencyKey: input.idempotencyKey,
						payload: input.payload,
					}),
				});
				if (result.kind === "conflict")
					throw new EnvelopeConflictError(result.reason);
				return result.envelope;
			},
			fail(error: string, retryAfterMs = retryAfter(envelope.attempts)) {
				requirePrepared();
				requireRetryDelay(retryAfterMs);
				const diagnostic = sanitizeDiagnostic(error);
				const exhausted = envelope.attempts >= envelope.maxAttempts;
				return settle(
					exhausted ? "dead_letter" : "retrying",
					diagnostic,
					exhausted ? undefined : options.clock.after(retryAfterMs),
				);
			},
			delivered() {
				requirePrepared();
				return settle("delivered");
			},
		});
	}

	const service: DurableDeliveryService = {
		enqueue,
		claim(workerId, limit = 1, leaseMs = defaultLeaseMs) {
			requireIdentifier(workerId, "delivery worker");
			requireLease(leaseMs);
			const now = options.clock.now();
			const rows = options.storage.claimEnvelopes({
				workerId,
				now,
				claimUntil: options.clock.after(leaseMs),
				limit: requireClaimLimit(limit),
			});
			return Object.freeze(rows.map(wrapClaim));
		},
		recover() {
			return options.storage.recoverEnvelopes(options.clock.now());
		},
	};
	return Object.freeze(service);
}
