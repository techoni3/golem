import {
	type ManagedCodexDeliveryPort,
	type ManagedCodexEndpointPort,
	type ManagedCodexIngress,
	ManagedCodexSupervisor,
	type ManagedCodexSupervisorOptions,
} from "@golem/adapter-codex";
import type { EndpointService } from "@golem/runtime";
import type { EnvelopeClaim } from "@golem/tracker";

function stringField(
	input: Readonly<Record<string, unknown>>,
	key: string,
): string {
	const value = input[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`control_plane.managed_codex.${key}_required`);
	}
	return value;
}

function optionalString(
	input: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = input[key];
	return typeof value === "string" && value ? value : undefined;
}

function numberField(
	input: Readonly<Record<string, unknown>>,
	key: string,
): number {
	const value = input[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`control_plane.managed_codex.${key}_required`);
	}
	return value;
}

/**
 * Convert adapter-shaped endpoint operations to the canonical endpoint service
 * without giving the adapter a storage capability. The evidence is deliberately
 * structured at this one composition seam; adapters only report observations.
 */
export function createManagedCodexEndpointPort(
	endpoints: EndpointService,
): ManagedCodexEndpointPort {
	return Object.freeze({
		claim(input: Readonly<Record<string, unknown>>) {
			return Object.freeze({
				...endpoints.claim({
					endpointId: stringField(input, "endpointId"),
					generationId: stringField(input, "generationId"),
					routeKind: stringField(input, "routeKind") as "delivery" | "control",
					ownerInstanceId: stringField(input, "ownerInstanceId"),
					deliveryMode: "managed_app_server",
					readiness:
						(optionalString(input, "readiness") as
							| "ready"
							| "uninitialized"
							| undefined) ?? "uninitialized",
					controlState:
						(optionalString(input, "controlState") as
							| "enabled"
							| "disabled"
							| undefined) ?? "enabled",
					leaseMs: numberField(input, "leaseMs"),
				}),
			});
		},
		eligibility(input: Readonly<Record<string, unknown>>) {
			const requiredCapability = optionalString(input, "requiredCapability");
			const result = endpoints.eligibility({
				generationId: stringField(input, "generationId"),
				routeKind: stringField(input, "routeKind") as "delivery" | "control",
				...(requiredCapability ? { requiredCapability } : {}),
				...(typeof input.expectedOwnerFence === "number"
					? { expectedOwnerFence: input.expectedOwnerFence }
					: {}),
			});
			return Object.freeze({
				disposition: result.disposition,
				code: result.code,
				...(result.remedy ? { remedy: result.remedy } : {}),
			});
		},
		reportReadiness(input: Readonly<Record<string, unknown>>) {
			return endpoints.reportReadiness({
				endpointId: stringField(input, "endpointId"),
				generationId: stringField(input, "generationId"),
				ownerInstanceId: stringField(input, "ownerInstanceId"),
				ownerFence: numberField(input, "ownerFence"),
				deliveryMode: "managed_app_server",
				readiness: stringField(input, "readiness") as "ready",
				...(optionalString(input, "controlState")
					? { controlState: optionalString(input, "controlState") as "enabled" }
					: {}),
			});
		},
		probe(input: Readonly<Record<string, unknown>>) {
			return endpoints.probe({
				endpointId: stringField(input, "endpointId"),
				generationId: stringField(input, "generationId"),
				ownerInstanceId: stringField(input, "ownerInstanceId"),
				ownerFence: numberField(input, "ownerFence"),
				consumerReady: input.consumerReady === true,
				...(optionalString(input, "readiness")
					? { readiness: optionalString(input, "readiness") as "ready" }
					: {}),
			});
		},
		reportHealth(input: Readonly<Record<string, unknown>>) {
			return endpoints.reportHealth({
				endpointId: stringField(input, "endpointId"),
				generationId: stringField(input, "generationId"),
				ownerInstanceId: stringField(input, "ownerInstanceId"),
				ownerFence: numberField(input, "ownerFence"),
				state: stringField(input, "state") as "healthy" | "degraded",
			});
		},
		reportCapability(input: Readonly<Record<string, unknown>>) {
			const readiness = stringField(input, "readiness") as
				| "ready"
				| "uninitialized"
				| "unsupported";
			return endpoints.reportCapability({
				endpointId: stringField(input, "endpointId"),
				generationId: stringField(input, "generationId"),
				ownerInstanceId: stringField(input, "ownerInstanceId"),
				ownerFence: numberField(input, "ownerFence"),
				capability: {
					capability: stringField(input, "capability"),
					adapterId: "golem.adapter.codex",
					adapterVersion: "1",
					qualification: "supported",
					deliveryMode: "managed_app_server",
					readiness,
					evidenceKind: stringField(input, "evidenceKind") as
						| "probe"
						| "configured"
						| "observed"
						| "operator",
					observedAt: stringField(input, "observedAt"),
				},
				evidence: {
					consumptionObserved: input.consumptionObserved === true,
				},
			});
		},
		reportDelivery(input: Readonly<Record<string, unknown>>) {
			return endpoints.reportDelivery({
				endpointId: stringField(input, "endpointId"),
				generationId: stringField(input, "generationId"),
				ownerInstanceId: stringField(input, "ownerInstanceId"),
				ownerFence: numberField(input, "ownerFence"),
				status: stringField(input, "status") as
					| "accepted"
					| "delivered"
					| "failed",
				...(optionalString(input, "readiness")
					? { readiness: optionalString(input, "readiness") as "ready" }
					: {}),
			});
		},
		release(input: Readonly<Record<string, unknown>>) {
			return endpoints.release({
				endpointId: stringField(input, "endpointId"),
				generationId: stringField(input, "generationId"),
				ownerInstanceId: stringField(input, "ownerInstanceId"),
				ownerFence: numberField(input, "ownerFence"),
			});
		},
	});
}

/** The only application factory that joins a Codex adapter to canonical ports. */
export function composeManagedCodexSupervisor(options: {
	readonly endpoints: EndpointService;
	readonly ingress: ManagedCodexIngress;
	readonly supervisor: Omit<
		ManagedCodexSupervisorOptions,
		"endpoints" | "ingress"
	>;
}): ManagedCodexSupervisor {
	return new ManagedCodexSupervisor({
		...options.supervisor,
		endpoints: createManagedCodexEndpointPort(options.endpoints),
		ingress: options.ingress,
	});
}

/**
 * Adapt one already-claimed canonical envelope to the managed Codex adapter.
 *
 * The adapter owns the App Server request; the tracker claim remains the sole
 * authority for eligibility, fence rechecks, acknowledgement, retry, and
 * recovery. This tiny composition seam deliberately holds no database handle
 * and no delivery-id cache. A recovered lease builds a fresh port around the
 * same durable envelope and reuses its id as `clientUserMessageId`.
 */
export function createManagedCodexDeliveryPort(options: {
	readonly claim: EnvelopeClaim;
	readonly acknowledgementPrefix?: string;
}): ManagedCodexDeliveryPort {
	let prepared = false;
	let sent = false;
	const envelope = options.claim.envelope;
	const acknowledgementPrefix =
		options.acknowledgementPrefix ?? "codex-managed";

	return Object.freeze({
		async claim(input: Readonly<Record<string, unknown>>) {
			if (
				input.deliveryId !== envelope.id ||
				input.generationId !== envelope.endpoint.generationId ||
				input.expectedOwnerFence !== envelope.endpoint.ownerFence
			)
				return Object.freeze({
					disposition: "rejected",
					code: "control_plane.managed_codex.claim_binding_mismatch",
				});
			const preparedClaim = options.claim.prepare();
			if (preparedClaim.kind !== "deliver")
				return Object.freeze({
					disposition: "rejected",
					code: `control_plane.managed_codex.claim_${preparedClaim.reason}`,
				});
			prepared = true;
			return Object.freeze({ disposition: "accepted" });
		},
		async markSent(input: Readonly<Record<string, unknown>>) {
			if (!prepared || input.deliveryId !== envelope.id)
				throw new Error("control_plane.managed_codex.sent_without_claim");
			if (sent) return;
			options.claim.delivered();
			sent = true;
		},
		async ack(input: Readonly<Record<string, unknown>>) {
			if (!prepared || input.deliveryId !== envelope.id)
				throw new Error("control_plane.managed_codex.ack_without_claim");
			const turnId =
				typeof input.turnId === "string" ? input.turnId : undefined;
			const acknowledged = options.claim.acknowledge(
				`${acknowledgementPrefix}:${envelope.id}`,
				turnId ? { turn_id: turnId } : {},
			);
			if (!acknowledged)
				throw new Error("control_plane.managed_codex.ack_rejected");
		},
		async fail(input: Readonly<Record<string, unknown>>) {
			if (!prepared || input.deliveryId !== envelope.id)
				throw new Error("control_plane.managed_codex.fail_without_claim");
			// Once `delivered` has committed, a post-send failure (for example a
			// process crash before acknowledgement) must not reopen the envelope.
			// The durable marker is intentionally stronger than this process-local
			// attempt; recovery observes no claimable envelope and cannot duplicate
			// the App Server turn.
			if (sent) return;
			options.claim.fail(
				typeof input.reason === "string"
					? input.reason
					: "managed_codex_delivery_failed",
			);
		},
	});
}
