import type { PersistenceWriteCapability } from "@golem/persistence";
import {
	createTrackerServices,
	type DeliveryEligibilityPort,
	type TrackerClock,
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
