import type { PersistenceWriteCapability } from "@golem/persistence";

export interface RuntimeOutboxDestination {
	deliver(input: {
		readonly id: string;
		readonly payload: Readonly<Record<string, unknown>>;
	}): Promise<void>;
}

export interface RuntimeOutboxDrainResult {
	readonly claimed: number;
	readonly acknowledged: number;
	readonly deferred: number;
	readonly permanentFailures: number;
}

/**
 * Cross-store delivery is at-least-once by design. Destination consumers must
 * use the stable outbox id as their idempotency key before acknowledging it.
 */
export class RuntimeOutboxDrainer {
	readonly #writer: PersistenceWriteCapability;
	readonly #destinations: ReadonlyMap<string, RuntimeOutboxDestination>;
	readonly #workerId: string;

	constructor(options: {
		readonly writer: PersistenceWriteCapability;
		readonly destinations: Readonly<Record<string, RuntimeOutboxDestination>>;
		readonly workerId: string;
	}) {
		if (!options.workerId.trim())
			throw new Error("outbox worker id is required");
		this.#writer = options.writer;
		this.#destinations = new Map(Object.entries(options.destinations));
		this.#workerId = options.workerId;
	}

	async drain(limit = 100): Promise<RuntimeOutboxDrainResult> {
		const claimed = this.#writer.claimRuntimeOutbox(this.#workerId, limit);
		const result = {
			claimed: claimed.length,
			acknowledged: 0,
			deferred: 0,
			permanentFailures: 0,
		};
		for (const entry of claimed) {
			const destination = this.#destinations.get(entry.destination);
			if (!destination) {
				const failure = this.#writer.failRuntimeOutbox(
					entry.id,
					entry.claimToken,
					`no runtime outbox destination registered for ${entry.destination}`,
				);
				if (failure?.status === "permanent_failure")
					result.permanentFailures += 1;
				else result.deferred += 1;
				continue;
			}
			try {
				await destination.deliver({ id: entry.id, payload: entry.payload });
				if (this.#writer.ackRuntimeOutbox(entry.id, entry.claimToken))
					result.acknowledged += 1;
			} catch (error) {
				const failure = this.#writer.failRuntimeOutbox(
					entry.id,
					entry.claimToken,
					error instanceof Error ? error.message : String(error),
				);
				if (failure?.status === "permanent_failure")
					result.permanentFailures += 1;
				else result.deferred += 1;
			}
		}
		return Object.freeze(result);
	}
}
