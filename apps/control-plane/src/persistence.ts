import type {
	PersistenceOpenOptions,
	PersistencePaths,
	PersistenceWriteCapability,
} from "@golem/persistence";
import { openPersistenceForControlPlane } from "@golem/persistence/control-plane";

/** The sole application composition point that may obtain a persistence writer. */
export function openControlPlanePersistence(
	paths: PersistencePaths,
	options?: PersistenceOpenOptions,
): PersistenceWriteCapability {
	return openPersistenceForControlPlane(paths, options);
}
