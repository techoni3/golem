import { z } from "zod";

import {
	ClockFactsBodySchema,
	DeliveryModeSchema,
	DeliveryReadinessSchema,
	EndpointRouteStateSchema,
	GenerationReferenceBodySchema,
	HarnessSchema,
	LifecycleStateSchema,
	ProvenanceBodySchema,
} from "./common.js";
import { EndpointIdSchema } from "./ids.js";
import { wireVersion } from "./version.js";

export const ClockFactsSchema = z
	.object({
		schema_version: wireVersion("clock-facts"),
		...ClockFactsBodySchema.shape,
	})
	.strict()
	.superRefine((value, context) => {
		const observedAt = Date.parse(value.source_observed_at);
		const receivedAt = Date.parse(value.received_at);
		if (observedAt > receivedAt) {
			context.addIssue({
				code: "custom",
				message: "wire.clock.observed_after_received",
				path: ["received_at"],
			});
		}
		if (
			value.source_event_at &&
			Date.parse(value.source_event_at) > receivedAt
		) {
			context.addIssue({
				code: "custom",
				message: "wire.clock.source_after_received",
				path: ["received_at"],
			});
		}
		if (
			value.materialized_at &&
			Date.parse(value.materialized_at) < receivedAt
		) {
			context.addIssue({
				code: "custom",
				message: "wire.clock.materialized_before_received",
				path: ["materialized_at"],
			});
		}
	});

export const ProvenanceSchema = z
	.object({
		schema_version: wireVersion("provenance"),
		...ProvenanceBodySchema.shape,
	})
	.strict();

export const LifecycleFactsBodySchema = z
	.object({
		generation: GenerationReferenceBodySchema,
		state: LifecycleStateSchema,
		started_at: z.iso.datetime({ offset: true }).optional(),
		last_activity_at: z.iso.datetime({ offset: true }).optional(),
		ended_at: z.iso.datetime({ offset: true }).optional(),
		reason: z.string().min(1).max(256).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.started_at && value.ended_at) {
			if (Date.parse(value.ended_at) < Date.parse(value.started_at)) {
				context.addIssue({
					code: "custom",
					message: "wire.lifecycle.ended_before_started",
					path: ["ended_at"],
				});
			}
		}
	});

export const LifecycleFactsSchema = z
	.object({
		schema_version: wireVersion("lifecycle-facts"),
		...LifecycleFactsBodySchema.shape,
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.started_at &&
			value.ended_at &&
			Date.parse(value.ended_at) < Date.parse(value.started_at)
		) {
			context.addIssue({
				code: "custom",
				message: "wire.lifecycle.ended_before_started",
				path: ["ended_at"],
			});
		}
	});

export const EndpointRecordBodySchema = z
	.object({
		endpoint_id: EndpointIdSchema,
		generation: GenerationReferenceBodySchema,
		state: EndpointRouteStateSchema,
		owner_fence: z.string().min(1).max(256),
		delivery_mode: DeliveryModeSchema,
		readiness: DeliveryReadinessSchema,
		revision: z.number().int().nonnegative(),
		last_heartbeat_at: z.iso.datetime({ offset: true }).optional(),
	})
	.strict();

export const EndpointRecordSchema = z
	.object({
		schema_version: wireVersion("endpoint-record"),
		...EndpointRecordBodySchema.shape,
	})
	.strict();

export const CapabilityRecordBodySchema = z
	.object({
		capability_id: z.string().min(1).max(160),
		harness: HarnessSchema,
		adapter_version: z.string().min(1).max(64),
		integration_layers: z
			.array(
				z.enum([
					"extension",
					"hooks",
					"mcp",
					"channel",
					"app_server",
					"prompt_bridge",
				]),
			)
			.min(1),
		qualification: z.enum([
			"supported",
			"experimental",
			"unsupported",
			"unknown",
		]),
		delivery_mode: DeliveryModeSchema,
		readiness: DeliveryReadinessSchema,
		reason_code: z.string().min(1).max(128).optional(),
		evidence_version: z.string().min(1).max(64).optional(),
	})
	.strict();

export const CapabilityRecordSchema = z
	.object({
		schema_version: wireVersion("capability-record"),
		...CapabilityRecordBodySchema.shape,
	})
	.strict();

export type ClockFactsEnvelope = z.infer<typeof ClockFactsSchema>;
export type ProvenanceEnvelope = z.infer<typeof ProvenanceSchema>;
export type LifecycleFacts = z.infer<typeof LifecycleFactsSchema>;
export type EndpointRecord = z.infer<typeof EndpointRecordSchema>;
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;
