export type { CapabilityResolution } from "./capabilities.js";
export { resolveCapability } from "./capabilities.js";
export {
	attachAlias,
	generationFor,
	projectObserved,
	startOrResume,
} from "./identity.js";
export { lifecycleDecision, lifecycleRank } from "./lifecycle.js";
export type { DomainProjections } from "./projections.js";
export { projectDomain } from "./projections.js";
export { reduceDomain } from "./reducer.js";
export type {
	CapabilityFact,
	Disposition,
	DomainEffect,
	DomainExplanation,
	DomainState,
	EndpointClaim,
	FieldProvenance,
	GenerationRecord,
	ProjectRecord,
	ReducerClock,
	ReducerResult,
	ScopedAlias,
	SessionRecord,
} from "./types.js";
export { emptyDomainState } from "./types.js";

import { resolveCapability } from "./capabilities.js";
import { attachAlias } from "./identity.js";
import { projectDomain } from "./projections.js";
import { reduceDomain } from "./reducer.js";
import type { DomainState } from "./types.js";
import { emptyDomainState } from "./types.js";

/** The typed seam consumed by runtime and tracker; every operation is pure. */
export interface DomainBoundary {
	readonly empty: () => DomainState;
	readonly reduce: typeof reduceDomain;
	readonly attachAlias: typeof attachAlias;
	readonly resolveCapability: typeof resolveCapability;
	readonly project: typeof projectDomain;
}

export const domainBoundary: DomainBoundary = {
	empty: emptyDomainState,
	reduce: reduceDomain,
	attachAlias,
	resolveCapability,
	project: projectDomain,
};
