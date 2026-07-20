import {
	type AppendBusEventResult,
	type BusEvent,
	BusEventConflictError,
	type JsonObject,
	type TrackerClock,
	type TrackerStoragePort,
} from "./types.js";
import {
	requireBusClass,
	requireIdentifier,
	requireJsonObject,
} from "./validation.js";

function fingerprint(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${fingerprint(object[key])}`)
		.join(",")}}`;
}

export interface DurableBusService {
	append(input: {
		readonly id: string;
		readonly deduplicationKey: string;
		readonly topic: string;
		readonly class: BusEvent["class"];
		readonly payload: JsonObject;
	}): BusEvent;
}

export function createDurableBusService(options: {
	readonly storage: TrackerStoragePort;
	readonly clock: TrackerClock;
}): DurableBusService {
	const service: DurableBusService = {
		append(input) {
			requireIdentifier(input.id, "bus event id");
			requireIdentifier(input.deduplicationKey, "bus deduplication key");
			requireIdentifier(input.topic, "bus topic");
			requireBusClass(input.class);
			requireJsonObject(input.payload, "bus payload");
			const event = Object.freeze({
				id: input.id,
				deduplicationKey: input.deduplicationKey,
				topic: input.topic,
				class: input.class,
				payload: Object.freeze({ ...input.payload }),
				createdAt: options.clock.now(),
			});
			const result: AppendBusEventResult = options.storage.appendBusEvent({
				event,
				fingerprint: fingerprint({
					deduplicationKey: input.deduplicationKey,
					topic: input.topic,
					class: input.class,
					payload: input.payload,
				}),
			});
			if (result.kind === "conflict")
				throw new BusEventConflictError(result.reason);
			return result.event;
		},
	};
	return Object.freeze(service);
}
