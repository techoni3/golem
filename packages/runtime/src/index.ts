import type { DomainBoundary } from "@golem/domain";
import type { PersistenceBoundary } from "@golem/persistence";

export interface RuntimeBoundary {
	readonly domain: DomainBoundary;
	readonly persistence: PersistenceBoundary;
}
