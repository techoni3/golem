import type {
	TrackerCoreActorContext,
	TrackerCoreAuditRecord,
	TrackerCoreComment,
	TrackerCoreExceptionalClose,
	TrackerCoreLink,
	TrackerCoreLinkRelation,
	TrackerCoreMutationMetadata,
	TrackerCorePhaseEvidence,
	TrackerCorePriority,
	TrackerCoreRuntimeReference,
	TrackerCoreState,
	TrackerCoreStorageCapability,
	TrackerCoreStream,
	TrackerCoreWorkItem,
	TrackerCoreWorkItemKind,
} from "@golem/persistence";

/**
 * Application-facing tracker-core storage port. The concrete SQLite repository
 * stays private to @golem/persistence and only control-plane composition can
 * hand this narrow capability to the service layer.
 */
export type TrackerCoreStoragePort = TrackerCoreStorageCapability;
export type {
	TrackerCoreActorContext,
	TrackerCoreAuditRecord,
	TrackerCoreComment,
	TrackerCoreExceptionalClose,
	TrackerCoreLink,
	TrackerCoreLinkRelation,
	TrackerCoreMutationMetadata,
	TrackerCorePhaseEvidence,
	TrackerCorePriority,
	TrackerCoreRuntimeReference,
	TrackerCoreState,
	TrackerCoreStream,
	TrackerCoreWorkItem,
	TrackerCoreWorkItemKind,
};
