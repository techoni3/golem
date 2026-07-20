import type {
	TrackerCoreStoragePort,
	TrackerCoreStream,
} from "../repositories/port.js";
import {
	createTrackerMutation,
	requireTrackerActor,
	requireTrackerText,
	TrackerCoreError,
} from "../tickets/service.js";
import type { TrackerClock } from "../types.js";

export interface TrackerStreamService {
	upsert(input: {
		readonly id?: string;
		readonly projectId: string;
		readonly name: string;
		readonly mode?: "sequential" | "parallel";
		readonly description?: string;
		readonly expectedRevision?: number;
		readonly actor: string;
	}): TrackerCoreStream;
	list(projectId?: string): readonly TrackerCoreStream[];
}

export function createTrackerStreamService(options: {
	readonly storage: TrackerCoreStoragePort;
	readonly clock: TrackerClock;
}): TrackerStreamService {
	const service: TrackerStreamService = {
		upsert(input: Parameters<TrackerStreamService["upsert"]>[0]) {
			if (
				input.mode !== undefined &&
				input.mode !== "sequential" &&
				input.mode !== "parallel"
			)
				throw new TrackerCoreError(
					"tracker.input.invalid",
					"stream mode is unsupported",
				);
			if (
				input.expectedRevision !== undefined &&
				(!Number.isSafeInteger(input.expectedRevision) ||
					input.expectedRevision < 1)
			)
				throw new TrackerCoreError(
					"tracker.input.invalid",
					"stream revision must be a positive safe integer",
				);
			const now = options.clock.now();
			const actor = requireTrackerActor(input.actor);
			const stream: TrackerCoreStream = Object.freeze({
				id:
					input.id === undefined
						? `str_${globalThis.crypto.randomUUID()}`
						: requireTrackerText(input.id, "stream id"),
				projectId: requireTrackerText(input.projectId, "project id"),
				name: requireTrackerText(input.name, "stream name"),
				mode: input.mode ?? "parallel",
				description: input.description ?? "",
				revision: 1,
				createdAt: now,
				updatedAt: now,
			});
			const persisted = options.storage.upsertStream({
				stream,
				...(input.expectedRevision === undefined
					? {}
					: { expectedRevision: input.expectedRevision }),
				mutation: createTrackerMutation(options.clock, actor),
			});
			if (!persisted)
				throw new TrackerCoreError(
					"tracker.conflict",
					"stream revision is stale",
				);
			return persisted;
		},
		list(projectId?: string) {
			return options.storage.listStreams(projectId);
		},
	};
	return Object.freeze(service);
}
