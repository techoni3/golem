import type { RuntimeSignalV1 } from "@golem/contracts";

import { explanation, result } from "./explain.js";
import { compareFieldVersion, fieldVersion } from "./ordering.js";
import type {
	DomainEffect,
	DomainState,
	EndpointClaim,
	EndpointFact,
	ReducerResult,
} from "./types.js";
import { orderedRecord } from "./types.js";

function fenceEffect(
	endpoint: EndpointClaim | undefined,
	signal: RuntimeSignalV1,
): DomainEffect | undefined {
	if (!endpoint)
		return {
			disposition: "rejected",
			explanation: explanation("domain.endpoint.unknown", "error", {
				eventId: signal.event_id,
			}),
		};
	if (signal.owner_fence !== endpoint.ownerFence)
		return {
			disposition: "rejected",
			explanation: explanation("domain.endpoint.fence_stale", "error", {
				endpointId: endpoint.endpointId,
				expectedFence: endpoint.ownerFence,
				receivedFence: signal.owner_fence ?? "missing",
			}),
		};
	return undefined;
}

export function endpointClaim(
	state: DomainState,
	endpoint: EndpointFact,
	signal: RuntimeSignalV1,
): ReducerResult {
	const previous = state.endpoints[endpoint.endpoint_id];
	const version = fieldVersion(signal);
	if (previous && endpoint.revision < previous.revision)
		return result(state, "rejected", "domain.endpoint.fence_stale", {
			endpointId: endpoint.endpoint_id,
			incomingRevision: endpoint.revision,
			currentRevision: previous.revision,
		});
	if (
		previous &&
		endpoint.revision === previous.revision &&
		endpoint.owner_fence < previous.ownerFence
	)
		return result(state, "ignored", "domain.ordering.tie_lost", {
			endpointId: endpoint.endpoint_id,
			revision: endpoint.revision,
		});
	if (
		previous &&
		endpoint.revision === previous.revision &&
		endpoint.owner_fence === previous.ownerFence &&
		(compareFieldVersion(version, previous.claimProvenance) <= 0 ||
			compareFieldVersion(version, previous.stateProvenance) <= 0)
	)
		return result(state, "ignored", "domain.ordering.field_stale", {
			endpointId: endpoint.endpoint_id,
			field: "endpoint_claim",
		});
	const preservesHeartbeat =
		previous &&
		endpoint.revision === previous.revision &&
		endpoint.owner_fence === previous.ownerFence;
	const heartbeat = endpoint.last_heartbeat_at
		? {
				lastHeartbeatAt: endpoint.last_heartbeat_at,
				heartbeatProvenance: version,
			}
		: preservesHeartbeat && previous.lastHeartbeatAt
			? {
					lastHeartbeatAt: previous.lastHeartbeatAt,
					...(previous.heartbeatProvenance
						? { heartbeatProvenance: previous.heartbeatProvenance }
						: {}),
				}
			: {};
	const claim: EndpointClaim = {
		endpointId: endpoint.endpoint_id,
		generationId: endpoint.generation.generation_id,
		ownerFence: endpoint.owner_fence,
		revision: endpoint.revision,
		state: endpoint.state,
		deliveryMode: endpoint.delivery_mode,
		readiness: endpoint.readiness,
		...heartbeat,
		claimProvenance: version,
		stateProvenance: version,
	};
	return result(
		{
			...state,
			endpoints: orderedRecord({
				...state.endpoints,
				[claim.endpointId]: claim,
			}),
		},
		"applied",
		"domain.event.applied",
		{ endpointId: claim.endpointId, revision: claim.revision },
	);
}

export function heartbeat(
	state: DomainState,
	signal: RuntimeSignalV1,
): ReducerResult {
	if (signal.payload.kind !== "endpoint.heartbeat")
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	const endpoint = state.endpoints[signal.payload.endpoint.endpoint_id];
	const fenced = fenceEffect(endpoint, signal);
	if (fenced) return { state, effect: fenced };
	if (!endpoint)
		return result(state, "rejected", "domain.endpoint.unknown", {
			eventId: signal.event_id,
		});
	const version = fieldVersion(signal);
	if (compareFieldVersion(version, endpoint.heartbeatProvenance) <= 0)
		return result(state, "ignored", "domain.ordering.field_stale", {
			endpointId: endpoint.endpointId,
			field: "endpoint_heartbeat",
		});
	const updated: EndpointClaim = {
		...endpoint,
		lastHeartbeatAt: signal.payload.heartbeat_at,
		heartbeatProvenance: version,
	};
	return result(
		{
			...state,
			endpoints: orderedRecord({
				...state.endpoints,
				[endpoint.endpointId]: updated,
			}),
		},
		"applied",
		"domain.event.applied",
		{ endpointId: endpoint.endpointId, heartbeatOnly: true },
	);
}

export function releaseEndpoint(
	state: DomainState,
	signal: RuntimeSignalV1,
): ReducerResult {
	if (signal.payload.kind !== "endpoint.released")
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	const endpoint = state.endpoints[signal.payload.endpoint.endpoint_id];
	const fenced = fenceEffect(endpoint, signal);
	if (fenced) return { state, effect: fenced };
	if (!endpoint)
		return result(state, "rejected", "domain.endpoint.unknown", {
			eventId: signal.event_id,
		});
	const version = fieldVersion(signal);
	if (compareFieldVersion(version, endpoint.stateProvenance) <= 0)
		return result(state, "ignored", "domain.ordering.field_stale", {
			endpointId: endpoint.endpointId,
			field: "endpoint_state",
		});
	const {
		lastHeartbeatAt: _lastHeartbeatAt,
		heartbeatProvenance: _heartbeatProvenance,
		...releasedEndpoint
	} = endpoint;
	const updated: EndpointClaim = {
		...releasedEndpoint,
		state: "released",
		readiness: "uninitialized",
		claimProvenance: version,
		stateProvenance: version,
	};
	return result(
		{
			...state,
			endpoints: orderedRecord({
				...state.endpoints,
				[endpoint.endpointId]: updated,
			}),
		},
		"applied",
		"domain.event.applied",
		{ endpointId: endpoint.endpointId },
	);
}
