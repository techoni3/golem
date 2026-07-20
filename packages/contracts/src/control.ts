import { z } from "zod";

import {
	ActorReferenceBodySchema,
	EndpointReferenceBodySchema,
	GenerationReferenceBodySchema,
	ProjectLocationReferenceBodySchema,
	ProjectReferenceBodySchema,
	SessionReferenceBodySchema,
} from "./common.js";
import {
	CommandIdSchema,
	DeliveryIdSchema,
	MigrationPlanIdSchema,
} from "./ids.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";
import { wireVersion } from "./version.js";

export const ControlCommandKinds = [
	"project.register",
	"project.archive",
	"project.location_decide",
	"preset.upsert",
	"preset.delete",
	"launch.prepare",
	"session.control",
	"dispatch.enqueue",
	"dispatch.cancel",
	"dispatch.retry",
	"migration.plan",
	"migration.apply",
	"migration.rollback",
	"compatibility.cutover",
] as const;

export const ControlCommandKindSchema = z.enum(ControlCommandKinds);

const ControlTargetSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("project"), project: ProjectReferenceBodySchema })
		.strict(),
	z
		.object({ kind: z.literal("session"), session: SessionReferenceBodySchema })
		.strict(),
	z
		.object({
			kind: z.literal("generation"),
			generation: GenerationReferenceBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("endpoint"),
			endpoint: EndpointReferenceBodySchema,
		})
		.strict(),
]);

const ControlCommandPayloadSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("project.register"),
			project: ProjectReferenceBodySchema,
			location: ProjectLocationReferenceBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("project.archive"),
			project: ProjectReferenceBodySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("project.location_decide"),
			project: ProjectReferenceBodySchema,
			location: ProjectLocationReferenceBodySchema,
			decision: z.enum(["attach", "reject"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("preset.upsert"),
			preset_name: z.string().min(1).max(128),
			preset: JsonObjectSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("preset.delete"),
			preset_name: z.string().min(1).max(128),
		})
		.strict(),
	z
		.object({
			kind: z.literal("launch.prepare"),
			harness: z.enum(["claude", "codex", "opencode", "pi"]),
			preset_name: z.string().min(1).max(128).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.enum(["interrupt", "halt", "resume", "rename", "set_role"]),
			input: JsonObjectSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("dispatch.enqueue"),
			endpoint: EndpointReferenceBodySchema,
			payload: JsonValueSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("dispatch.cancel"),
			delivery_id: DeliveryIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("dispatch.retry"),
			delivery_id: DeliveryIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("migration.plan"),
			scope: z.enum(["runtime", "tracker", "config"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("migration.apply"),
			plan_id: MigrationPlanIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("migration.rollback"),
			plan_id: MigrationPlanIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("compatibility.cutover"),
			stage: z.enum(["C1", "C2", "C3", "C4", "C5"]),
		})
		.strict(),
]);

export const ControlCommandV1Schema = z
	.object({
		schema_version: wireVersion("control-command"),
		command_id: CommandIdSchema,
		command_kind: ControlCommandKindSchema,
		actor: ActorReferenceBodySchema,
		correlation_id: z.string().min(1).max(128),
		causation_id: CommandIdSchema.optional(),
		idempotency_key: z.string().min(1).max(256),
		target: ControlTargetSchema.optional(),
		expected_revision: z.number().int().nonnegative().optional(),
		endpoint_fence: z.string().min(1).max(256).optional(),
		audit: z
			.object({
				request_source: z.enum(["cli", "dashboard", "mcp", "service"]),
				redacted_metadata: JsonObjectSchema,
			})
			.strict(),
		payload: ControlCommandPayloadSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.command_kind !== value.payload.kind) {
			context.addIssue({
				code: "custom",
				message: "wire.control_command.kind_mismatch",
				path: ["payload", "kind"],
			});
		}
	});

export type ControlCommandV1 = z.infer<typeof ControlCommandV1Schema>;
export type ControlCommandKind = z.infer<typeof ControlCommandKindSchema>;
