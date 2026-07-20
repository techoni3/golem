/**
 * Public persistence boundary. It exports contracts and migration facts only;
 * opening a writable database is reserved for the control-plane composition.
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
	PersistenceClock,
	PersistenceOpenOptions,
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

import { runtimeMigrations, trackerMigrations } from "./schema.js";

export const persistenceMigrations = Object.freeze({
	runtime: runtimeMigrations.map(({ id, checksum }) => ({ id, checksum })),
	tracker: trackerMigrations.map(({ id, checksum }) => ({ id, checksum })),
});
