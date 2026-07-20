import { createDurableBusService, type DurableBusService } from "./bus.js";
import {
	createDurableDeliveryService,
	type DurableDeliveryService,
} from "./delivery.js";
import {
	createPassiveSlotService,
	type PassiveSlotService,
} from "./passive.js";
import {
	createDurableSubscriptionService,
	type DurableSubscriptionService,
} from "./subscriptions.js";
import type {
	DeliveryEligibilityPort,
	TrackerClock,
	TrackerStoragePort,
} from "./types.js";
import { requireTimestamp } from "./validation.js";

export interface TrackerServices {
	readonly delivery: DurableDeliveryService;
	readonly bus: DurableBusService;
	readonly subscriptions: DurableSubscriptionService;
	readonly passive: PassiveSlotService;
	prune(before: string): {
		readonly events: number;
		readonly envelopes: number;
		readonly auditId: string;
	};
	audit(): ReturnType<TrackerStoragePort["audit"]>;
}

export function createTrackerServices(options: {
	readonly storage: TrackerStoragePort;
	readonly eligibility: DeliveryEligibilityPort;
	readonly clock: TrackerClock;
}): TrackerServices {
	const services: TrackerServices = {
		delivery: createDurableDeliveryService(options),
		bus: createDurableBusService(options),
		subscriptions: createDurableSubscriptionService(options),
		passive: createPassiveSlotService(options),
		prune(before) {
			requireTimestamp(before, "prune before");
			return options.storage.prune({ now: options.clock.now(), before });
		},
		audit() {
			return options.storage.audit();
		},
	};
	return Object.freeze(services);
}
