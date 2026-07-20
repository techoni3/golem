import type { RuntimeSignalV1 } from "@golem/contracts";

import { explanation, result } from "./explain.js";
import type {
	DomainEffect,
	DomainState,
	FieldProvenance,
	GenerationRecord,
	ReducerClock,
	ReducerResult,
	Watermark,
} from "./types.js";
import { orderedRecord } from "./types.js";

export function sourceTime(signal: RuntimeSignalV1): string {
	return signal.clocks.source_event_at ?? signal.clocks.source_observed_at;
}

export function fieldVersion(signal: RuntimeSignalV1): FieldProvenance {
	return {
		eventId: signal.event_id,
		producerInstanceId: signal.producer_instance_id,
		sourceTime: sourceTime(signal),
		tieBreak: `${signal.event_id}:${signal.producer_instance_id}`,
	};
}

export function compareFieldVersion(
	incoming: FieldProvenance,
	current: FieldProvenance | undefined,
): number {
	if (!current) return 1;
	const source = incoming.sourceTime.localeCompare(current.sourceTime);
	return source !== 0
		? source
		: incoming.tieBreak.localeCompare(current.tieBreak);
}

function eventOrderKey(signal: RuntimeSignalV1): string {
	return `${sourceTime(signal)}|${signal.event_id}|${signal.producer_instance_id}`;
}

function watermarkKey(signal: RuntimeSignalV1): string {
	const generation =
		"generation" in signal.payload
			? signal.payload.generation.generation_id
			: "project" in signal.payload
				? signal.payload.project.project_id
				: "global";
	return `${signal.producer_instance_id}:${generation}`;
}

function compareWatermark(left: Watermark, right: Watermark): number {
	return (
		left.sequence - right.sequence ||
		left.orderKey.localeCompare(right.orderKey)
	);
}

export function orderingEffect(
	state: DomainState,
	signal: RuntimeSignalV1,
): DomainEffect | undefined {
	if (state.seenEventIds[signal.event_id])
		return {
			disposition: "ignored",
			explanation: explanation("domain.event.duplicate", "info", {
				eventId: signal.event_id,
			}),
		};
	if (signal.producer_sequence === undefined) return undefined;
	const previous = state.watermarks[watermarkKey(signal)];
	if (!previous) return undefined;
	if (signal.producer_sequence < previous.sequence)
		return {
			disposition: "ignored",
			explanation: explanation("domain.ordering.stale_sequence", "warning", {
				incoming: signal.producer_sequence,
				watermark: previous.sequence,
			}),
		};
	if (
		signal.producer_sequence === previous.sequence &&
		eventOrderKey(signal) <= previous.orderKey
	)
		return {
			disposition: "ignored",
			explanation: explanation("domain.ordering.tie_lost", "warning", {
				sequence: signal.producer_sequence,
			}),
		};
	return undefined;
}

/** All non-duplicate input facts are remembered, even if policy rejects them. */
export function recordObservation(
	state: DomainState,
	signal: RuntimeSignalV1,
): DomainState {
	if (state.seenEventIds[signal.event_id]) return state;
	const seenEventIds = orderedRecord({
		...state.seenEventIds,
		[signal.event_id]: true as const,
	});
	if (signal.producer_sequence === undefined) return { ...state, seenEventIds };
	const key = watermarkKey(signal);
	const incoming = {
		sequence: signal.producer_sequence,
		orderKey: eventOrderKey(signal),
	};
	const current = state.watermarks[key];
	const watermarks =
		!current || compareWatermark(incoming, current) > 0
			? orderedRecord({ ...state.watermarks, [key]: incoming })
			: state.watermarks;
	return { ...state, seenEventIds, watermarks };
}

export function patchMetadata(
	state: DomainState,
	generation: GenerationRecord,
	signal: RuntimeSignalV1,
	clock: ReducerClock,
): ReducerResult {
	if (signal.payload.kind !== "session.metadata_patched")
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	const version = fieldVersion(signal);
	const patch = signal.payload.metadata;
	const metadata = { ...generation.metadata };
	const fieldProvenance = { ...generation.fieldProvenance };
	const changed: string[] = [];
	const stale: string[] = [];
	for (const field of [
		...Object.keys(patch).sort(),
		...signal.clear_fields.filter((field) => !(field in patch)).sort(),
	]) {
		if (compareFieldVersion(version, fieldProvenance[field]) <= 0) {
			stale.push(field);
			continue;
		}
		if (field in patch) metadata[field] = patch[field];
		else delete metadata[field];
		fieldProvenance[field] = version;
		changed.push(field);
	}
	if (changed.length === 0)
		return result(state, "ignored", "domain.ordering.field_stale", {
			eventId: signal.event_id,
			fields: stale.length,
		});
	const updated: GenerationRecord = {
		...generation,
		metadata: orderedRecord(metadata),
		fieldProvenance: orderedRecord(fieldProvenance),
		clocks: {
			...generation.clocks,
			metadataUpdatedAt: sourceTime(signal),
			lastSourceObservedAt: signal.clocks.source_observed_at,
			receivedAt: signal.clocks.received_at,
			materializedAt: clock.materializedAt,
		},
	};
	return result(
		{
			...state,
			generations: orderedRecord({
				...state.generations,
				[updated.generationId]: updated,
			}),
		},
		"applied",
		"domain.event.applied",
		{ eventId: signal.event_id, fields: changed.length, stale: stale.length },
	);
}
