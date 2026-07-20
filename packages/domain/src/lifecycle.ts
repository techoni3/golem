import type { LifecycleState, RuntimeSignalV1 } from "@golem/contracts";

import { explanation, result } from "./explain.js";
import { compareFieldVersion, fieldVersion, sourceTime } from "./ordering.js";
import type {
	DomainEffect,
	DomainState,
	GenerationClocks,
	GenerationRecord,
	ReducerClock,
	ReducerResult,
} from "./types.js";
import { orderedRecord } from "./types.js";

/** Operational states share one stage so active/idle/waiting may interleave. */
export const lifecycleRank: Readonly<Record<LifecycleState, number>> = {
	starting: 0,
	idle: 1,
	active: 1,
	waiting: 1,
	ending: 2,
	ended: 3,
	errored: 3,
	superseded: 3,
};

const terminalStates = new Set<LifecycleState>([
	"ended",
	"errored",
	"superseded",
]);

export function isTerminal(state: LifecycleState): boolean {
	return terminalStates.has(state);
}

export function lifecycleDecision(
	current: LifecycleState,
	next: LifecycleState,
): DomainEffect {
	const currentRank = lifecycleRank[current] ?? 0;
	const nextRank = lifecycleRank[next] ?? 0;
	const facts = { current, next, currentRank, nextRank };
	if (current === next)
		return {
			disposition: "ignored",
			explanation: explanation("domain.lifecycle.duplicate", "info", facts),
		};
	if (nextRank < currentRank)
		return {
			disposition: "rejected",
			explanation: explanation(
				isTerminal(current)
					? "domain.lifecycle.terminal"
					: "domain.lifecycle.regression",
				"error",
				facts,
			),
		};
	if (isTerminal(current) && !isTerminal(next))
		return {
			disposition: "rejected",
			explanation: explanation("domain.lifecycle.terminal", "error", facts),
		};
	return {
		disposition: "applied",
		explanation: explanation("domain.event.applied", "info", facts),
	};
}

/**
 * A lifecycle fact is a semilattice join: stage wins before source order.
 * Terminal names share the terminal stage and use provenance to choose one
 * terminal classification without ever returning to a non-terminal stage.
 */
function acceptsLifecycleFact(
	generation: GenerationRecord,
	next: LifecycleState,
	incomingVersion: ReturnType<typeof fieldVersion>,
): boolean {
	const currentRank = lifecycleRank[generation.state] ?? 0;
	const nextRank = lifecycleRank[next] ?? 0;
	if (nextRank !== currentRank) return nextRank > currentRank;
	return (
		compareFieldVersion(incomingVersion, generation.lifecycleProvenance) > 0
	);
}

export function transitionGeneration(
	state: DomainState,
	generation: GenerationRecord,
	next: LifecycleState,
	signal: RuntimeSignalV1,
	clock: ReducerClock,
): ReducerResult {
	const incomingVersion = fieldVersion(signal);
	const lifecycleApplies = acceptsLifecycleFact(
		generation,
		next,
		incomingVersion,
	);
	const activityFactIsNewer =
		next === "active" &&
		!isTerminal(generation.state) &&
		compareFieldVersion(incomingVersion, generation.activityProvenance) > 0;
	/* A stale operational label can still advance the independent activity fact. */
	const activityOnlyApplies =
		activityFactIsNewer &&
		lifecycleRank[next] === lifecycleRank[generation.state];
	if (!lifecycleApplies) {
		if (activityOnlyApplies) {
			const updated: GenerationRecord = {
				...generation,
				activityProvenance: incomingVersion,
				clocks: {
					...generation.clocks,
					lastActivityAt: sourceTime(signal),
				},
			};
			return result(
				{
					...state,
					generations: orderedRecord({
						...state.generations,
						[generation.generationId]: updated,
					}),
				},
				"applied",
				"domain.event.applied",
				{ eventId: signal.event_id, field: "activity" },
			);
		}
		const decision = lifecycleDecision(generation.state, next);
		if (decision.disposition === "rejected") return { state, effect: decision };
		return result(state, "ignored", "domain.ordering.field_stale", {
			eventId: signal.event_id,
			field: "lifecycle",
		});
	}
	const decision = lifecycleDecision(generation.state, next);
	if (decision.disposition !== "applied") return { state, effect: decision };
	const clocks: GenerationClocks = {
		...generation.clocks,
		lastSourceObservedAt: signal.clocks.source_observed_at,
		receivedAt: signal.clocks.received_at,
		materializedAt: clock.materializedAt,
		...(next === "active" ? { lastActivityAt: sourceTime(signal) } : {}),
		...(isTerminal(next) ? { endedAt: sourceTime(signal) } : {}),
	};
	const updated: GenerationRecord = {
		...generation,
		state: next,
		lifecycleProvenance: incomingVersion,
		...(activityFactIsNewer ? { activityProvenance: incomingVersion } : {}),
		clocks,
	};
	return result(
		{
			...state,
			generations: orderedRecord({
				...state.generations,
				[generation.generationId]: updated,
			}),
		},
		"applied",
		"domain.event.applied",
		{ eventId: signal.event_id, state: next },
	);
}
