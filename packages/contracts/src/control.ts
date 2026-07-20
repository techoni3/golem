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
import { LauncherPresetBodySchema } from "./launcher.js";
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

const SessionMetadataKeySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z][a-z0-9_.-]*$/u, "wire.session_metadata.key_invalid");

export const SessionMetadataPatchSchema = z
	.object({
		patch: z.record(SessionMetadataKeySchema, JsonValueSchema),
		clear_fields: z.array(SessionMetadataKeySchema).max(64),
	})
	.strict()
	.superRefine((value, context) => {
		const patchKeys = Object.keys(value.patch);
		if (patchKeys.length === 0 && value.clear_fields.length === 0) {
			context.addIssue({
				code: "custom",
				message: "wire.session_metadata.empty_mutation",
				path: ["patch"],
			});
		}
		for (const [index, field] of value.clear_fields.entries()) {
			if (field in value.patch) {
				context.addIssue({
					code: "custom",
					message: "wire.session_metadata.patch_clear_conflict",
					path: ["clear_fields", index],
				});
			}
		}
	});

export const SessionRoleSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9-]*$/u, "wire.session_role.invalid");

const SessionControlPayloadSchema = z.discriminatedUnion("action", [
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.literal("interrupt"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.literal("halt"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.literal("resume"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.literal("rename"),
			name: z.string().min(1).max(160),
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.literal("set_role"),
			role: SessionRoleSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("session.control"),
			generation: GenerationReferenceBodySchema,
			action: z.literal("patch_metadata"),
			metadata: SessionMetadataPatchSchema,
		})
		.strict(),
]);

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
			preset: LauncherPresetBodySchema,
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
	SessionControlPayloadSchema,
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
		if (
			value.payload.kind === "preset.upsert" &&
			value.payload.preset_name !== value.payload.preset.name
		) {
			context.addIssue({
				code: "custom",
				message: "wire.preset.name_mismatch",
				path: ["payload", "preset", "name"],
			});
		}
	});

export type ControlCommandV1 = z.infer<typeof ControlCommandV1Schema>;
export type ControlCommandKind = z.infer<typeof ControlCommandKindSchema>;
export type SessionMetadataPatch = z.infer<typeof SessionMetadataPatchSchema>;
export type SessionRole = z.infer<typeof SessionRoleSchema>;
