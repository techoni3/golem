import type {
	BusEvent,
	PendingSubscriptionEvents,
	Subscription,
	TrackerClock,
	TrackerStoragePort,
} from "./types.js";
import {
	requireCursor,
	requireCursorRange,
	requireIdentifier,
	requireSubscriptionClasses,
	requireSubscriptionPendingLimit,
	requireSubscriptionStatus,
} from "./validation.js";

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
			if (input.id !== undefined)
				requireIdentifier(input.id, "subscription id");
			requireIdentifier(input.name, "subscription name");
			requireIdentifier(input.recipientId, "subscription recipient");
			requireIdentifier(input.topic, "subscription topic");
			const classes = requireSubscriptionClasses(
				input.classes ?? ["tracker", "lifecycle", "custom"],
			);
			const cursor = requireCursor(input.cursor ?? 0);
			requireSubscriptionStatus(input.status ?? "active");
			return options.storage.upsertSubscription({
				id: input.id ?? globalThis.crypto.randomUUID(),
				name: input.name,
				recipientId: input.recipientId,
				topic: input.topic,
				classes: Object.freeze([...classes]),
				cursor,
				manual: input.manual ?? true,
				status: input.status ?? "active",
				createdAt: options.clock.now(),
			});
		},
		pending(id, limit = 100) {
			requireIdentifier(id, "subscription id");
			return options.storage.pendingSubscriptionEvents({
				id,
				limit: requireSubscriptionPendingLimit(limit),
			});
		},
		commit(id, fromSequence, toSequence) {
			requireIdentifier(id, "subscription id");
			requireCursorRange(fromSequence, toSequence);
			return options.storage.advanceSubscriptionCursor({
				id,
				fromSequence,
				toSequence,
			});
		},
	};
	return Object.freeze(service);
}
