import type {
	BusEvent,
	PendingSubscriptionEvents,
	Subscription,
	TrackerClock,
	TrackerStoragePort,
} from "./types.js";

export interface DurableSubscriptionService {
	subscribe(input: {
		readonly id?: string;
		readonly name: string;
		readonly recipientId: string;
		readonly topic: string;
		readonly classes?: readonly BusEvent["class"][];
		readonly cursor?: number;
		readonly manual?: boolean;
		readonly status?: Subscription["status"];
	}): Subscription;
	pending(id: string, limit?: number): PendingSubscriptionEvents | undefined;
	commit(id: string, fromSequence: number, toSequence: number): boolean;
}

export function createDurableSubscriptionService(options: {
	readonly storage: TrackerStoragePort;
	readonly clock: TrackerClock;
}): DurableSubscriptionService {
	const service: DurableSubscriptionService = {
		subscribe(input) {
			if (
				!input.name.trim() ||
				!input.recipientId.trim() ||
				!input.topic.trim()
			)
				throw new Error("subscription requires name, recipient, and topic");
			const classes = input.classes ?? ["tracker", "lifecycle", "custom"];
			if (classes.length === 0)
				throw new Error("subscription requires at least one event class");
			return options.storage.upsertSubscription({
				id: input.id ?? globalThis.crypto.randomUUID(),
				name: input.name,
				recipientId: input.recipientId,
				topic: input.topic,
				classes: Object.freeze([...classes]),
				cursor: input.cursor ?? 0,
				manual: input.manual ?? true,
				status: input.status ?? "active",
				createdAt: options.clock.now(),
			});
		},
		pending(id, limit = 100) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
				throw new Error(
					"subscription pending limit must be an integer from 1 to 1000",
				);
			return options.storage.pendingSubscriptionEvents({ id, limit });
		},
		commit(id, fromSequence, toSequence) {
			if (!Number.isInteger(fromSequence) || !Number.isInteger(toSequence))
				throw new Error("subscription cursor values must be integers");
			return options.storage.advanceSubscriptionCursor({
				id,
				fromSequence,
				toSequence,
			});
		},
	};
	return Object.freeze(service);
}
