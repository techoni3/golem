/**
 * Durable runtime ingress. Producers only receive `RuntimeInbox`; only the
 * single control-plane composition receives `RuntimeMaterializer` and the
 * narrow persistence write capability it needs.
 */
import type { DomainBoundary } from "@golem/domain";
import type { PersistenceBoundary } from "@golem/persistence";

/** Preserved Wave-4 composition marker; it is deliberately not a DB writer. */
export interface RuntimeBoundary {
	readonly domain: DomainBoundary;
	readonly persistence: PersistenceBoundary;
}

export {
	type InboxReceipt,
	RuntimeInbox,
	type RuntimeInboxMetrics,
	type RuntimeInboxOptions,
} from "./inbox.js";
export {
	createRuntimeMaterializer,
	type MaterializerDrainResult,
	RuntimeMaterializer,
	type RuntimeMaterializerHandler,
	type RuntimeMaterializerHandlerResult,
} from "./materializer.js";
export {
	type RuntimeOutboxDestination,
	RuntimeOutboxDrainer,
	type RuntimeOutboxDrainResult,
} from "./outbox.js";
