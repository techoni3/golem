import type { PersistenceWriteCapability } from "@golem/persistence";
import {
	createTrackerCoreServices,
	createTrackerServices,
	type DeliveryEligibilityPort,
	type TrackerClock,
	type TrackerCoreActorContext,
	type TrackerCoreServices,
	type TrackerServices,
} from "@golem/tracker";

/**
 * The only application composition seam that joins the single SQLite owner to
 * tracker delivery. The tracker receives typed storage, never a connection.
 */
export function composeControlPlaneTrackerServices(options: {
	readonly writer: PersistenceWriteCapability;
	readonly eligibility: DeliveryEligibilityPort;
	readonly clock: TrackerClock;
}): TrackerServices {
	return createTrackerServices({
		storage: options.writer.trackerStorage(),
		eligibility: options.eligibility,
		clock: options.clock,
	});
}

/**
 * Separate composition seam for tickets/comments/phases. It exposes the
 * legacy-shape facade to a route adapter without letting that adapter obtain a
 * raw database connection or make runtime readiness decisions.
 */
export function composeControlPlaneTrackerCoreServices(options: {
	readonly writer: PersistenceWriteCapability;
	readonly clock: TrackerClock;
	readonly trustedExceptionalCloseContext?: TrackerCoreActorContext;
}): TrackerCoreServices {
	return createTrackerCoreServices({
		storage: options.writer.trackerCoreStorage(),
		clock: options.clock,
		...(options.trustedExceptionalCloseContext === undefined
			? {}
			: {
					trustedExceptionalCloseContext:
						options.trustedExceptionalCloseContext,
				}),
	});
}
