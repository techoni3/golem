import type {
	ClaimedCommittedPublicationRecord,
	CommittedPublicationStorage,
} from "@golem/persistence";

import type { ControlPlaneReplayPort } from "./ports.js";
import type { ControlPlaneStream } from "./schemas.js";

function streamFor(
	record: ClaimedCommittedPublicationRecord,
): ControlPlaneStream {
	if (record.category === "communication") return "communication.operations";
	return record.resourceType.startsWith("tracker.")
		? "tracker.tree"
		: "tracker.board";
}

/**
 * Drains only committed, allowlisted publication rows. The frame payload is an
 * invalidation hint, never a domain/audit/command projection; HTTP remains the
 * canonical read path.
 */
export class CommittedPublicationDispatcher {
	readonly #storage: CommittedPublicationStorage;
	readonly #replay: ControlPlaneReplayPort;
	readonly #workerId: string;
	readonly #now: () => string;

	constructor(options: {
		readonly storage: CommittedPublicationStorage;
		readonly replay: ControlPlaneReplayPort;
		readonly workerId: string;
		readonly now: () => string;
	}) {
		this.#storage = options.storage;
		this.#replay = options.replay;
		this.#workerId = options.workerId;
		this.#now = options.now;
	}

	drain(limit = 64): number {
		const now = this.#now();
		this.#storage.recover(now);
		const claimed = this.#storage.claim({
			workerId: this.#workerId,
			now,
			claimUntil: new Date(Date.parse(now) + 30_000).toISOString(),
			limit,
		});
		let published = 0;
		for (const record of claimed) {
			this.#replay.publish(
				streamFor(record),
				record.projectRevision,
				Object.freeze({ kind: "invalidation", category: record.category }),
				{
					projectId: record.projectId,
					policyVersion: record.policyVersion,
				},
			);
			if (
				this.#storage.ack({
					id: record.id,
					claimToken: record.claimToken,
					publishedAt: this.#now(),
				})
			)
				published += 1;
		}
		return published;
	}
}
