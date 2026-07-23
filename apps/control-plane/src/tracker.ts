import type {
	PersistenceWriteCapability,
	RuntimeEndpointStorage,
	RuntimeSessionStorage,
} from "@golem/persistence";
import {
	createCommandGateway,
	createTicketDispatchService,
	createTrackerCoreServices,
	createTrackerManagementServices,
	createTrackerServices,
	type CommandGateway,
	type DeliveryEligibilityPort,
	type TrackerClock,
	type TrackerCoreActorContext,
	type TrackerCoreServices,
	type TrackerManagementIdentityPort,
	type TrackerManagementServices,
	type TrackerServices,
	type TicketDispatchService,
	TrackerCoreError,
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
 * Compose the single typed command gateway.  All tracker, management,
 * communications, and browser-originated mutations execute through this
 * service inside one canonical tracker transaction.  Adapters (browser,
 * bearer, MCP, legacy compat, internal/core) only translate transport into
 * the gateway envelope; they cannot forge authority or bypass the durable
 * receipt/outcome/idempotency primitive.
 */
export function composeControlPlaneCommandGateway(options: {
	readonly writer: PersistenceWriteCapability;
	readonly clock: TrackerClock;
	readonly core: TrackerCoreServices;
}): CommandGateway {
	return createCommandGateway({
		storage: options.writer.commandGatewayStorage(),
		clock: options.clock,
		core: options.core,
	});
}

/** Adapt the canonical GOL-42 endpoint capability into the tracker delivery
 * port.  The tracker re-resolves this snapshot at prepare(), so a queued
 * envelope cannot retain a stale generation/fence/readiness decision. */
export function composeControlPlaneEndpointEligibility(options: {
	readonly endpoints: RuntimeEndpointStorage;
	readonly clock: TrackerClock;
}): DeliveryEligibilityPort {
	return Object.freeze({
		resolve(recipientId: string) {
			const direct = options.endpoints.get(recipientId);
			const generationId = direct?.generationId ?? recipientId;
			const eligibility = options.endpoints.deliveryEligibility({
				generationId,
				routeKind: "delivery",
				requiredCapability: "delivery",
				now: options.clock.now(),
			});
			const endpoint = eligibility.endpoint;
			if (eligibility.disposition === "ineligible" || !endpoint) return undefined;
			return Object.freeze({
				recipientId,
				generationId: endpoint.generationId,
				endpointId: endpoint.endpointId,
				ownerFence: endpoint.ownerFence,
				readiness: endpoint.readiness,
				mode: endpoint.deliveryMode,
				capabilities: endpoint.capabilities.map((capability) => ({
					capability: capability.capability,
					qualification: capability.qualification,
					observedAt: capability.observedAt,
				})),
			});
		},
	});
}

/**
 * The narrow GOL-82 bridge.  It composes canonical tracker/runtime facts only;
 * browser, bearer, and MCP adapters receive this service rather than storage,
 * endpoint, or delivery handles.
 */
export function composeControlPlaneTicketDispatchService(options: {
	readonly writer: PersistenceWriteCapability;
	readonly core: TrackerCoreServices;
	readonly services: TrackerServices;
	readonly eligibility: DeliveryEligibilityPort;
}): TicketDispatchService {
	const sessions = options.writer.runtimeSessionStorage();
	return createTicketDispatchService({
		tickets: {
			get(projectId, ticketId) {
				const ticket = options.core.tickets.get(ticketId)?.ticket;
				return ticket?.projectId === projectId ? ticket : undefined;
			},
			record(input) {
				try {
					return options.core.tickets.recordDispatch(input);
				} catch (error) {
					if (error instanceof TrackerCoreError && error.code === "tracker.conflict")
						return undefined;
					throw error;
				}
			},
		},
		sessions: {
			resolve: (projectId, reference) =>
				sessions.resolveLogicalSession(projectId, reference),
		},
		eligibility: options.eligibility,
		delivery: options.services.delivery,
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
