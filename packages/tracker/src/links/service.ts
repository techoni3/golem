import type {
	TrackerCoreLink,
	TrackerCoreLinkRelation,
	TrackerCoreStoragePort,
} from "../repositories/port.js";
import {
	createTrackerMutation,
	requireTrackerActor,
	requireTrackerText,
	TrackerCoreError,
} from "../tickets/service.js";
import type { TrackerClock } from "../types.js";

const relations = new Set<TrackerCoreLinkRelation>([
	"blocks",
	"relates",
	"duplicates",
]);

export interface TrackerLinkService {
	create(input: {
		readonly ticketId: string;
		readonly targetTicketId: string;
		readonly relation: TrackerCoreLinkRelation;
		readonly actor: string;
	}): TrackerCoreLink;
	delete(input: {
		readonly ticketId: string;
		readonly targetTicketId: string;
		readonly relation: TrackerCoreLinkRelation;
		readonly actor: string;
	}): boolean;
}

export function createTrackerLinkService(options: {
	readonly storage: TrackerCoreStoragePort;
	readonly clock: TrackerClock;
}): TrackerLinkService {
	const service: TrackerLinkService = {
		create(input: Parameters<TrackerLinkService["create"]>[0]) {
			const ticketId = requireTrackerText(input.ticketId, "ticket id");
			const targetTicketId = requireTrackerText(
				input.targetTicketId,
				"linked ticket id",
			);
			if (ticketId === targetTicketId)
				throw new TrackerCoreError(
					"tracker.input.invalid",
					"a ticket cannot link to itself",
				);
			if (
				!options.storage.getWorkItem(ticketId) ||
				!options.storage.getWorkItem(targetTicketId)
			)
				throw new TrackerCoreError(
					"tracker.not_found",
					"linked ticket does not exist",
				);
			if (!relations.has(input.relation))
				throw new TrackerCoreError(
					"tracker.input.invalid",
					"link relation is unsupported",
				);
			const actor = requireTrackerActor(input.actor);
			const link: TrackerCoreLink = Object.freeze({
				id: `lnk_${globalThis.crypto.randomUUID()}`,
				ticketId,
				targetTicketId,
				relation: input.relation,
				actor,
				createdAt: options.clock.now(),
			});
			return options.storage.createLink({
				link,
				mutation: createTrackerMutation(options.clock, actor),
			});
		},
		delete(input: Parameters<TrackerLinkService["delete"]>[0]) {
			const ticketId = requireTrackerText(input.ticketId, "ticket id");
			const targetTicketId = requireTrackerText(
				input.targetTicketId,
				"linked ticket id",
			);
			if (!relations.has(input.relation))
				throw new TrackerCoreError(
					"tracker.input.invalid",
					"link relation is unsupported",
				);
			const actor = requireTrackerActor(input.actor);
			return options.storage.deleteLink({
				ticketId,
				targetTicketId,
				relation: input.relation,
				mutation: createTrackerMutation(options.clock, actor),
			});
		},
	};
	return Object.freeze(service);
}
