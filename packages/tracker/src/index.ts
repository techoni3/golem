import type { DomainBoundary } from "@golem/domain";

export {
	createDurableBusService,
	type DurableBusService,
} from "./bus.js";
export {
	createTrackerCommentService,
	type TrackerCommentService,
} from "./comments/service.js";
export {
	createTrackerCompatibilityFacade,
	type TrackerCompatibilityFacade,
} from "./compat.js";
export {
	createTrackerCoreServices,
	type TrackerCoreServices,
} from "./core.js";
export {
	createDurableDeliveryService,
	type DurableDeliveryService,
} from "./delivery.js";
export {
	type CommandGateway,
	CommandGatewayError,
	type CommandGatewayInput,
	type CommandGatewayOutcome,
	type CommandScope,
	createCommandGateway,
} from "./gateway.js";
export {
	createTrackerLinkService,
	type TrackerLinkService,
} from "./links/service.js";
export {
	createTrackerManagementServices,
	TrackerManagementError,
	type TrackerManagementIdentityPort,
	type TrackerManagementServices,
} from "./management.js";
export {
	createPassiveSlotService,
	type PassiveSlotService,
} from "./passive.js";
export {
	canonicalTrackerState,
	initialTrackerPhase,
	TrackerPhaseError,
	validateTrackerPhaseTransition,
} from "./phases/machine.js";
export type {
	TrackerCoreActorContext,
	TrackerCoreAuditRecord,
	TrackerCoreComment,
	TrackerCoreExceptionalClose,
	TrackerCoreLink,
	TrackerCoreLinkRelation,
	TrackerCoreMutationMetadata,
	TrackerCorePriority,
	TrackerCoreRuntimeReference,
	TrackerCoreState,
	TrackerCoreStoragePort,
	TrackerCoreStream,
	TrackerCoreWorkItem,
	TrackerCoreWorkItemKind,
} from "./repositories/port.js";
export { createTrackerServices, type TrackerServices } from "./services.js";
export {
	createTrackerStreamService,
	type TrackerStreamService,
} from "./streams/service.js";
export {
	createDurableSubscriptionService,
	type DurableSubscriptionService,
} from "./subscriptions.js";
export {
	createTrackerMutation,
	createTrackerTicketService,
	requireTrackerActor,
	requireTrackerText,
	TrackerCoreError,
	type TrackerTicketDetail,
	type TrackerTicketService,
} from "./tickets/service.js";
export {
	type AppendBusEventResult,
	type BusEvent,
	BusEventConflictError,
	type CapabilityQualification,
	type ClaimedDeliveryEnvelope,
	type ClaimedPassiveBatch,
	type CreateEnvelopeInput,
	type CreateEnvelopeResult,
	type DeliveryCapabilityEvidence,
	type DeliveryEligibility,
	type DeliveryEligibilityPort,
	type DeliveryEnvelope,
	type DeliveryMode,
	type DeliveryReadiness,
	type EnvelopeClaim,
	EnvelopeConflictError,
	type JsonObject,
	type PassiveDelta,
	type PendingSubscriptionEvents,
	type Subscription,
	type TrackerClock,
	type TrackerStoragePort,
} from "./types.js";
export {
	type TrackerValidationCode,
	TrackerValidationError,
	trackerValidationLimits,
} from "./validation.js";

export interface TrackerBoundary {
	readonly domain: DomainBoundary;
}
