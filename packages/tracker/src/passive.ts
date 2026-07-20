import type {
	ClaimedPassiveBatch,
	JsonObject,
	TrackerClock,
	TrackerStoragePort,
} from "./types.js";
import {
	requireIdentifier,
	requireJsonObject,
	requireLease,
} from "./validation.js";

export interface PassiveSlotService {
	append(input: {
		readonly recipientId: string;
		readonly ticketId: string;
		readonly category: string;
		readonly baseline: JsonObject;
		readonly value: JsonObject;
		readonly eventId: string;
	}): void;
	claim(recipientId: string, leaseMs?: number): ClaimedPassiveBatch | undefined;
	commit(recipientId: string, leaseId: string): boolean;
	release(recipientId: string, leaseId: string): boolean;
}

export function createPassiveSlotService(options: {
	readonly storage: TrackerStoragePort;
	readonly clock: TrackerClock;
}): PassiveSlotService {
	const service: PassiveSlotService = {
		append(input) {
			requireIdentifier(input.recipientId, "passive recipient");
			requireIdentifier(input.ticketId, "passive ticket");
			requireIdentifier(input.category, "passive category");
			requireIdentifier(input.eventId, "passive event id");
			requireJsonObject(input.baseline, "passive baseline");
			requireJsonObject(input.value, "passive value");
			options.storage.upsertPassiveDelta({
				...input,
				now: options.clock.now(),
			});
		},
		claim(recipientId, leaseMs = 30_000) {
			requireIdentifier(recipientId, "passive recipient");
			requireLease(leaseMs);
			return options.storage.claimPassiveBatch({
				recipientId,
				leaseId: globalThis.crypto.randomUUID(),
				leaseUntil: options.clock.after(leaseMs),
				now: options.clock.now(),
			});
		},
		commit(recipientId, leaseId) {
			requireIdentifier(recipientId, "passive recipient");
			requireIdentifier(leaseId, "passive lease id");
			return options.storage.commitPassiveBatch({
				recipientId,
				leaseId,
				now: options.clock.now(),
			});
		},
		release(recipientId, leaseId) {
			requireIdentifier(recipientId, "passive recipient");
			requireIdentifier(leaseId, "passive lease id");
			return options.storage.releasePassiveBatch({
				recipientId,
				leaseId,
				now: options.clock.now(),
			});
		},
	};
	return Object.freeze(service);
}
