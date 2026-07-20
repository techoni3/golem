import type {
	ClaimedPassiveBatch,
	JsonObject,
	TrackerClock,
	TrackerStoragePort,
} from "./types.js";

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
			if (
				!input.recipientId.trim() ||
				!input.ticketId.trim() ||
				!input.category.trim()
			)
				throw new Error(
					"passive delta requires recipient, ticket, and category",
				);
			options.storage.upsertPassiveDelta({
				...input,
				now: options.clock.now(),
			});
		},
		claim(recipientId, leaseMs = 30_000) {
			if (!recipientId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1)
				throw new Error("passive claim requires recipient and positive lease");
			return options.storage.claimPassiveBatch({
				recipientId,
				leaseId: globalThis.crypto.randomUUID(),
				leaseUntil: options.clock.after(leaseMs),
				now: options.clock.now(),
			});
		},
		commit(recipientId, leaseId) {
			return options.storage.commitPassiveBatch({
				recipientId,
				leaseId,
				now: options.clock.now(),
			});
		},
		release(recipientId, leaseId) {
			return options.storage.releasePassiveBatch({
				recipientId,
				leaseId,
				now: options.clock.now(),
			});
		},
	};
	return Object.freeze(service);
}
