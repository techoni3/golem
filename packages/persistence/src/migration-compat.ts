/**
 * Deliberately narrow legacy-import composition seam.  Compatibility migration
 * is the one exceptional reader of legacy homes, but persistence remains the
 * only SQLite writer and no connection escapes this module.
 */

import { openPersistenceForControlPlane } from "./owner.js";
import type {
	PersistenceOpenOptions,
	PersistencePaths,
	RuntimeProjectionStorage,
	RuntimeProjectStorage,
	RuntimeSessionStorage,
} from "./types.js";

export interface LegacyMigrationPersistence {
	readonly projects: RuntimeProjectStorage;
	readonly sessions: RuntimeSessionStorage;
	readonly projections: RuntimeProjectionStorage;
	close(): Promise<void>;
}

/**
 * Creates a capability-limited canonical target for a GOL-52 migration.
 * Consumers can materialize typed projects/sessions and read projections, but
 * cannot access SQLite, tracker delivery, endpoints, or arbitrary owner APIs.
 */
export function openLegacyMigrationPersistence(
	paths: PersistencePaths,
	options: PersistenceOpenOptions = {},
): LegacyMigrationPersistence {
	const owner = openPersistenceForControlPlane(paths, options);
	return Object.freeze({
		projects: owner.runtimeProjectStorage(),
		sessions: owner.runtimeSessionStorage(),
		projections: owner.runtimeProjectionStorage(),
		close: () => owner.close(),
	});
}
