import type {
	ClaimedCommittedPublicationRecord,
	CommittedPublicationStorage,
} from "@golem/persistence";
import {
	BrowserWorkInvalidationSchema,
	type BrowserWorkStream,
} from "@golem/contracts";

import type { BrowserWorkReplayPort, ControlPlaneReplayPort } from "./ports.js";
import type { ControlPlaneStream } from "./schemas.js";

function streamFor(
	record: ClaimedCommittedPublicationRecord,
): ControlPlaneStream {
	if (record.category === "communication") return "communication.operations";
	if (record.category === "management") return "management.controls";
	return record.resourceType.startsWith("tracker.")
		? "tracker.tree"
		: "tracker.board";
}

function browserStreamFor(
	record: ClaimedCommittedPublicationRecord,
): BrowserWorkStream {
	const invalidation = browserInvalidationFor(record);
	if (invalidation.category === "communication") return "communication.operations";
	if (invalidation.category === "management") return "management.controls";
	return record.resourceType.startsWith("tracker.")
		? "tracker.tree"
		: "tracker.board";
}

/** Asset and delivery rows are implementation detail. Browser observers receive
 * only the owning bounded projection category, never those storage categories. */
function browserInvalidationFor(record: ClaimedCommittedPublicationRecord) {
	return BrowserWorkInvalidationSchema.parse({
		kind: "invalidation",
		category:
			record.category === "communication" || record.category === "delivery"
				? "communication"
				: record.category === "management" || record.category === "asset"
					? "management"
					: "tracker",
	});
}

/**
 * Drains only committed, allowlisted publication rows. The frame payload is an
 * invalidation hint, never a domain/audit/command projection; HTTP remains the
 * canonical read path.
 */
export class CommittedPublicationDispatcher {
	readonly #storage: CommittedPublicationStorage;
	readonly #replay: ControlPlaneReplayPort;
	readonly #browserReplay: BrowserWorkReplayPort | undefined;
	readonly #workerId: string;
	readonly #now: () => string;

	constructor(options: {
		readonly storage: CommittedPublicationStorage;
		readonly replay: ControlPlaneReplayPort;
		readonly browserReplay?: BrowserWorkReplayPort;
		readonly workerId: string;
		readonly now: () => string;
	}) {
		this.#storage = options.storage;
		this.#replay = options.replay;
		this.#browserReplay = options.browserReplay;
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
			const scope = {
				projectId: record.projectId,
				policyVersion: record.policyVersion,
			};
			if (this.#browserReplay)
				this.#browserReplay.publishBrowserWork(
					browserStreamFor(record),
					record.projectRevision,
					browserInvalidationFor(record),
					scope,
				);
			else
				this.#replay.publish(
					streamFor(record),
					record.projectRevision,
					Object.freeze({ kind: "invalidation", category: record.category }),
					scope,
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
