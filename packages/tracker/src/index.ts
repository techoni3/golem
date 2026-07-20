import type { DomainBoundary } from "@golem/domain";

export {
	createDurableBusService,
	type DurableBusService,
} from "./bus.js";
export {
	createDurableDeliveryService,
	type DurableDeliveryService,
} from "./delivery.js";
export {
	createPassiveSlotService,
	type PassiveSlotService,
} from "./passive.js";
export { createTrackerServices, type TrackerServices } from "./services.js";
export {
	createDurableSubscriptionService,
	type DurableSubscriptionService,
} from "./subscriptions.js";
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

export interface TrackerBoundary {
	readonly domain: DomainBoundary;
}
