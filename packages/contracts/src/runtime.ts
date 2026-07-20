import { z } from "zod";

import {
	ClockFactsBodySchema,
	EndpointReferenceBodySchema,
	GenerationReferenceBodySchema,
	ProducerReferenceBodySchema,
	ProjectLocationReferenceBodySchema,
	ProjectReferenceBodySchema,
	ProvenanceBodySchema,
} from "./common.js";
import {
	CapabilityRecordBodySchema,
	EndpointRecordBodySchema,
} from "./facts.js";
import { EventIdSchema, GenerationIdSchema } from "./ids.js";
import { JsonObjectSchema } from "./json.js";
import { wireVersion } from "./version.js";

export const RuntimeSignalKinds = [
	"project.observed",
	"session.started",
	"session.resumed",
	"session.activity",
	"session.idle",
	"session.waiting",
	"session.metadata_patched",
	"session.ended",
	"endpoint.claimed",
	"endpoint.heartbeat",
	"endpoint.readiness_changed",
	"endpoint.released",
	"capabilities.reported",
] as const;

export const RuntimeSignalKindSchema = z.enum(RuntimeSignalKinds);

const RuntimeSignalPayloadSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("project.observed"),
			project: ProjectReferenceBodySchema,
			location: ProjectLocationReferenceBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.started"),
			generation: GenerationReferenceBodySchema,
			metadata: JsonObjectSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.resumed"),
			generation: GenerationReferenceBodySchema,
			resumed_from_generation_id: GenerationIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.activity"),
			generation: GenerationReferenceBodySchema,
			activity_kind: z.enum(["prompt", "tool", "response", "work"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.idle"),
			generation: GenerationReferenceBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.waiting"),
			generation: GenerationReferenceBodySchema,
			reason: z.string().min(1).max(256),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.metadata_patched"),
			generation: GenerationReferenceBodySchema,
			metadata: JsonObjectSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.ended"),
			generation: GenerationReferenceBodySchema,
			disposition: z.enum(["ended", "errored", "superseded"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("endpoint.claimed"),
			endpoint: EndpointRecordBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("endpoint.heartbeat"),
			endpoint: EndpointReferenceBodySchema,
			heartbeat_at: z.iso.datetime({ offset: true }),
		})
		.strict(),
	z
		.object({
			kind: z.literal("endpoint.readiness_changed"),
			endpoint: EndpointRecordBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("endpoint.released"),
			endpoint: EndpointReferenceBodySchema,
			reason: z.string().min(1).max(256),
		})
		.strict(),
	z
		.object({
			kind: z.literal("capabilities.reported"),
			project: ProjectReferenceBodySchema,
			capabilities: z.array(CapabilityRecordBodySchema).min(1),
		})
		.strict(),
]);

export const RuntimeSignalV1Schema = z
	.object({
		schema_version: wireVersion("runtime-signal"),
		event_id: EventIdSchema,
		event_kind: RuntimeSignalKindSchema,
		...ProducerReferenceBodySchema.shape,
		producer_sequence: z.number().int().nonnegative().optional(),
		correlation_id: z.string().min(1).max(128),
		causation_id: EventIdSchema.optional(),
		deduplication_key: z.string().min(1).max(256),
		owner_fence: z.string().min(1).max(256).optional(),
		clocks: ClockFactsBodySchema,
		provenance: ProvenanceBodySchema,
		clear_fields: z.array(z.string().min(1).max(160)).max(64),
		payload: RuntimeSignalPayloadSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.event_kind !== value.payload.kind) {
			context.addIssue({
				code: "custom",
				message: "wire.runtime_signal.kind_mismatch",
				path: ["payload", "kind"],
			});
		}
		const clocks = ClockFactsBodySchema.safeParse(value.clocks);
		if (!clocks.success) {
			for (const issue of clocks.error.issues) {
				context.addIssue({
					code: "custom",
					message: issue.message,
					path: ["clocks", ...issue.path],
				});
			}
		}
	});

export type RuntimeSignalV1 = z.infer<typeof RuntimeSignalV1Schema>;
export type RuntimeSignalKind = z.infer<typeof RuntimeSignalKindSchema>;
