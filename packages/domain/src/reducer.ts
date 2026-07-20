import type { RuntimeSignalV1 } from "@golem/contracts";
import { result } from "./explain.js";
import { generationFor, projectObserved, startOrResume } from "./identity.js";
import { isTerminal, transitionGeneration } from "./lifecycle.js";
import {
	compareFieldVersion,
	fieldVersion,
	orderingEffect,
	patchMetadata,
	recordObservation,
} from "./ordering.js";
import { endpointClaim, heartbeat, releaseEndpoint } from "./readiness.js";
import type { DomainState, ReducerClock, ReducerResult } from "./types.js";
import { orderedRecord } from "./types.js";

function transitionForSignal(
	state: DomainState,
	signal: RuntimeSignalV1,
	next: "active" | "idle" | "waiting",
	clock: ReducerClock,
): ReducerResult {
	const generation = generationFor(state, signal);
	return generation
		? transitionGeneration(state, generation, next, signal, clock)
		: result(state, "rejected", "domain.signal.unsupported", {
				eventId: signal.event_id,
			});
}

export function reduceDomain(
	state: DomainState,
	signal: RuntimeSignalV1,
	clock: ReducerClock,
): ReducerResult {
	const ordered = orderingEffect(state, signal);
	if (ordered)
		return { state: recordObservation(state, signal), effect: ordered };
	let reduced: ReducerResult;
	switch (signal.payload.kind) {
		case "project.observed":
			reduced = projectObserved(state, signal);
			break;
		case "session.started":
		case "session.resumed":
			reduced = startOrResume(state, signal, clock);
			break;
		case "session.activity":
			reduced = transitionForSignal(state, signal, "active", clock);
			break;
		case "session.idle":
			reduced = transitionForSignal(state, signal, "idle", clock);
			break;
		case "session.waiting":
			reduced = transitionForSignal(state, signal, "waiting", clock);
			break;
		case "session.ended": {
			const generation = generationFor(state, signal);
			reduced = generation
				? transitionGeneration(
						state,
						generation,
						signal.payload.disposition,
						signal,
						clock,
					)
				: result(state, "rejected", "domain.signal.unsupported", {
						eventId: signal.event_id,
					});
			break;
		}
		case "session.metadata_patched": {
			const generation = generationFor(state, signal);
			reduced = !generation
				? result(state, "rejected", "domain.signal.unsupported", {
						eventId: signal.event_id,
					})
				: isTerminal(generation.state)
					? result(state, "rejected", "domain.lifecycle.terminal", {
							eventId: signal.event_id,
							state: generation.state,
						})
					: patchMetadata(state, generation, signal, clock);
			break;
		}
		case "endpoint.claimed":
		case "endpoint.readiness_changed":
			reduced = endpointClaim(state, signal.payload.endpoint, signal);
			break;
		case "endpoint.heartbeat":
			reduced = heartbeat(state, signal);
			break;
		case "endpoint.released":
			reduced = releaseEndpoint(state, signal);
			break;
		case "capabilities.reported": {
			const capabilities = { ...state.capabilities };
			const version = fieldVersion(signal);
			let changed = 0;
			for (const capability of [...signal.payload.capabilities].sort(
				(left, right) => {
					const id = left.capability_id.localeCompare(right.capability_id);
					return (
						id || JSON.stringify(left).localeCompare(JSON.stringify(right))
					);
				},
			)) {
				const current = capabilities[capability.capability_id];
				if (current && compareFieldVersion(version, current.provenance) <= 0)
					continue;
				capabilities[capability.capability_id] = {
					capability,
					provenance: version,
				};
				changed += 1;
			}
			if (changed === 0) {
				reduced = result(state, "ignored", "domain.ordering.field_stale", {
					eventId: signal.event_id,
					field: "capability",
				});
				break;
			}
			reduced = result(
				{ ...state, capabilities: orderedRecord(capabilities) },
				"applied",
				"domain.event.applied",
				{ eventId: signal.event_id, count: changed },
			);
			break;
		}
		default:
			reduced = result(state, "rejected", "domain.signal.unsupported", {
				eventId: signal.event_id,
			});
	}
	return { ...reduced, state: recordObservation(reduced.state, signal) };
}
