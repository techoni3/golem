/**
 * Public persistence boundary. It exports contract types and one opaque
 * composition port; implementation details remain private modules.
 */
export { runtimeMigrations, trackerMigrations } from "./schema.js";
export type {
	ClaimedOutboxRecord,
	DatabaseHealth,
	DatabaseScope,
	DryRunEvidence,
	MigrationDefinition,
	MigrationMode,
	MigrationPlan,
	MigrationResult,
	PersistenceBoundary,
	PersistencePaths,
	PersistenceStatus,
	PersistenceWriteCapability,
	RuntimeCanonicalMutation,
	RuntimeFailpoint,
	RuntimeTransactionInput,
	RuntimeTransactionResult,
} from "./types.js";
export {
	PersistenceMigrationError,
	PersistenceOwnerConflictError,
	RuntimeFailpointError,
} from "./types.js";

import { openPersistenceForControlPlane } from "./owner.js";
import { runtimeMigrations, trackerMigrations } from "./schema.js";
import type { PersistencePaths, PersistenceWriteCapability } from "./types.js";

/** The sole composition capability intended for the control-plane app. */
export const persistenceCompositionPort: Readonly<{
	open(paths: PersistencePaths, ownerId?: string): PersistenceWriteCapability;
}> = Object.freeze({ open: openPersistenceForControlPlane });

export const persistenceMigrations = Object.freeze({
	runtime: runtimeMigrations.map(({ id, checksum }) => ({ id, checksum })),
	tracker: trackerMigrations.map(({ id, checksum }) => ({ id, checksum })),
});
