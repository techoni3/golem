import type { ContractBoundary } from "@golem/contracts";

export interface PersistenceBoundary {
	readonly contract: ContractBoundary;
}
