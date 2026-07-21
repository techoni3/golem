import type {
	PersistenceWriteCapability,
	RuntimeSessionStorage,
} from "@golem/persistence";
import {
	createTrackerCoreServices,
	createTrackerManagementServices,
	createTrackerServices,
	type DeliveryEligibilityPort,
	type TrackerClock,
	type TrackerCoreActorContext,
	type TrackerCoreServices,
	type TrackerManagementIdentityPort,
	type TrackerManagementServices,
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

/** Management remains a typed, owner-scoped capability; it has no runtime or
 * native transport authority and is only reachable from application wiring. */
export function composeControlPlaneManagementServices(options: {
	readonly writer: PersistenceWriteCapability;
	readonly clock: TrackerClock;
	readonly assetRoot: string;
	readonly tickets?: TrackerCoreServices["tickets"];
}): TrackerManagementServices {
	const sessions: RuntimeSessionStorage =
		options.writer.runtimeSessionStorage();
	const identity: TrackerManagementIdentityPort = {
		getSession: (projectId, sessionId) => sessions.get(projectId, sessionId),
		findGeneration: (projectId, generationId) =>
			sessions
				.list(projectId)
				.flatMap((session) => session.generations)
				.find((generation) => generation.generationId === generationId),
	};
	return createTrackerManagementServices({
		storage: options.writer.managementStorage(),
		clock: options.clock,
		assetRoot: options.assetRoot,
		identity,
		...(options.tickets ? { tickets: options.tickets } : {}),
	});
}
