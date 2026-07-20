import { z } from "zod";

import {
	ActorIdSchema,
	EndpointIdSchema,
	GenerationIdSchema,
	LocationIdSchema,
	ProducerIdSchema,
	ProjectIdSchema,
	SessionIdSchema,
} from "./ids.js";

export const HarnessSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export const LifecycleStateSchema = z.enum([
	"starting",
	"idle",
	"active",
	"waiting",
	"ending",
	"ended",
	"errored",
	"superseded",
]);
export const EndpointRouteStateSchema = z.enum([
	"claiming",
	"healthy",
	"degraded",
	"released",
	"expired",
	"superseded",
]);
export const DeliveryReadinessSchema = z.enum([
	"ready",
	"held_busy",
	"held_waiting",
	"pull_only",
	"next_turn",
	"unsupported",
	"unhealthy",
	"uninitialized",
]);
export const DeliveryModeSchema = z.enum([
	"pull",
	"native_channel",
	"prompt_bridge",
	"managed_app_server",
	"next_turn",
]);

const TimestampSchema = z.iso.datetime({ offset: true });

export const ProjectReferenceBodySchema = z
	.object({ project_id: ProjectIdSchema })
	.strict();

export const ProjectLocationReferenceBodySchema = z
	.object({
		project_id: ProjectIdSchema,
		location_id: LocationIdSchema,
		relation: z.enum(["main", "worktree", "registered", "legacy"]),
		canonical_path: z.string().min(1).max(4096),
		observed_path: z.string().min(1).max(4096).optional(),
	})
	.strict();

export const SessionReferenceBodySchema = z
	.object({
		project_id: ProjectIdSchema,
		session_id: SessionIdSchema,
	})
	.strict();

export const GenerationReferenceBodySchema = z
	.object({
		project_id: ProjectIdSchema,
		session_id: SessionIdSchema,
		generation_id: GenerationIdSchema,
	})
	.strict();

export const AliasReferenceBodySchema = z
	.object({
		project_id: ProjectIdSchema,
		harness: HarnessSchema,
		alias_kind: z.enum([
			"native_conversation",
			"native_run",
			"legacy_canonical_id",
			"supervisor_thread",
			"bridge_session",
			"migration_relation",
		]),
		alias: z.string().min(1).max(512),
		producer_id: ProducerIdSchema.optional(),
		session: SessionReferenceBodySchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.session && value.session.project_id !== value.project_id) {
			context.addIssue({
				code: "custom",
				message: "wire.alias.cross_scope",
				path: ["session", "project_id"],
			});
		}
	});

export const ActorReferenceBodySchema = z
	.object({
		actor_id: ActorIdSchema,
		kind: z.enum(["human", "service", "adapter", "session"]),
		display_name: z.string().min(1).max(160).optional(),
	})
	.strict();

export const ProducerReferenceBodySchema = z
	.object({
		producer: z.string().min(1).max(128),
		producer_instance_id: ProducerIdSchema,
		harness: HarnessSchema,
	})
	.strict();

export const ClockFactsBodySchema = z
	.object({
		source_observed_at: TimestampSchema,
		source_event_at: TimestampSchema.optional(),
		received_at: TimestampSchema,
		materialized_at: TimestampSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const observedAt = Date.parse(value.source_observed_at);
		const receivedAt = Date.parse(value.received_at);
		const sourceEventAt = value.source_event_at
			? Date.parse(value.source_event_at)
			: null;
		const materializedAt = value.materialized_at
			? Date.parse(value.materialized_at)
			: null;
		if (observedAt > receivedAt) {
			context.addIssue({
				code: "custom",
				message: "wire.clock.observed_after_received",
				path: ["received_at"],
			});
		}
		if (sourceEventAt !== null && sourceEventAt > receivedAt) {
			context.addIssue({
				code: "custom",
				message: "wire.clock.source_after_received",
				path: ["received_at"],
			});
		}
		if (materializedAt !== null && materializedAt < receivedAt) {
			context.addIssue({
				code: "custom",
				message: "wire.clock.materialized_before_received",
				path: ["materialized_at"],
			});
		}
	});

export const ProvenanceBodySchema = z
	.object({
		source: z.enum([
			"adapter",
			"api",
			"launcher",
			"legacy_import",
			"migration",
		]),
		evidence_id: z.string().min(1).max(256).optional(),
		confidence: z.enum(["verified", "observed", "inferred", "legacy"]),
	})
	.strict();

export const EndpointReferenceBodySchema = z
	.object({
		endpoint_id: EndpointIdSchema,
		generation: GenerationReferenceBodySchema,
	})
	.strict();

export type Harness = z.infer<typeof HarnessSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type EndpointRouteState = z.infer<typeof EndpointRouteStateSchema>;
export type DeliveryReadiness = z.infer<typeof DeliveryReadinessSchema>;
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;
export type ProjectReference = z.infer<typeof ProjectReferenceBodySchema>;
export type ProjectLocationReference = z.infer<
	typeof ProjectLocationReferenceBodySchema
>;
export type SessionReference = z.infer<typeof SessionReferenceBodySchema>;
export type GenerationReference = z.infer<typeof GenerationReferenceBodySchema>;
export type AliasReference = z.infer<typeof AliasReferenceBodySchema>;
export type ActorReference = z.infer<typeof ActorReferenceBodySchema>;
export type ProducerReference = z.infer<typeof ProducerReferenceBodySchema>;
export type ClockFacts = z.infer<typeof ClockFactsBodySchema>;
export type Provenance = z.infer<typeof ProvenanceBodySchema>;
export type EndpointReference = z.infer<typeof EndpointReferenceBodySchema>;
