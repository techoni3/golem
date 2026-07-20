import {
	createTrackerCommentService,
	type TrackerCommentService,
} from "./comments/service.js";
import {
	createTrackerCompatibilityFacade,
	type TrackerCompatibilityFacade,
} from "./compat.js";
import {
	createTrackerLinkService,
	type TrackerLinkService,
} from "./links/service.js";
import type {
	TrackerCoreActorContext,
	TrackerCoreStoragePort,
} from "./repositories/port.js";
import {
	createTrackerStreamService,
	type TrackerStreamService,
} from "./streams/service.js";
import {
	createTrackerTicketService,
	type TrackerTicketService,
} from "./tickets/service.js";
import type { TrackerClock } from "./types.js";

export interface TrackerCoreServices {
	readonly tickets: TrackerTicketService;
	readonly comments: TrackerCommentService;
	readonly links: TrackerLinkService;
	readonly streams: TrackerStreamService;
	readonly compatibility: TrackerCompatibilityFacade;
}

export function createTrackerCoreServices(options: {
	readonly storage: TrackerCoreStoragePort;
	readonly clock: TrackerClock;
	readonly trustedExceptionalCloseContext?: TrackerCoreActorContext;
}): TrackerCoreServices {
	const tickets = createTrackerTicketService(options);
	const services: Omit<TrackerCoreServices, "compatibility"> = Object.freeze({
		tickets,
		comments: createTrackerCommentService(options),
		links: createTrackerLinkService(options),
		streams: createTrackerStreamService(options),
	});
	return Object.freeze({
		...services,
		compatibility: createTrackerCompatibilityFacade(
			services as TrackerCoreServices,
			options.trustedExceptionalCloseContext === undefined
				? {}
				: {
						trustedExceptionalCloseContext:
							options.trustedExceptionalCloseContext,
					},
		),
	});
}
