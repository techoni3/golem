import type { PersistenceWriteCapability } from "@golem/persistence";
import type { ProjectService, ProjectServiceOptions } from "@golem/runtime";
import { createProjectService } from "@golem/runtime";

/**
 * Compose the project identity service only after the control-plane owner has
 * opened its runtime store. Routes are intentionally not attached in this
 * wave; later API work receives this typed service as a capability.
 */
export function composeControlPlaneProjectService(
	owner: PersistenceWriteCapability,
	options: Omit<ProjectServiceOptions, "storage"> = {},
): ProjectService {
	return createProjectService({
		...options,
		storage: owner.runtimeProjectStorage(),
	});
}
