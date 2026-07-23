import { z } from "zod";

const BrowserSettingsTimestampSchema = z.iso.datetime({ offset: true });
const BrowserSettingsTextSchema = z.string().min(1).max(512);
const BrowserSettingsPlanHashSchema = z
	.string()
	.regex(/^sha256:[a-f0-9]{64}$/u);
const BrowserSettingsHarnessSchema = z.enum([
	"claude",
	"codex",
	"opencode",
	"pi",
]);
const BrowserSettingsBackendSchema = z.enum([
	"openai",
	"anthropic",
	"ollama_local",
	"ollama_cloud",
	"native",
]);
const BrowserSettingsDeliveryModeSchema = z.enum([
	"pull",
	"native_channel",
	"prompt_bridge",
	"managed_app_server",
	"next_turn",
]);
const BrowserSettingsTargetSchema = z.enum([
	"cc",
	"cc-marketplace",
	"codex",
	"opencode",
	"pi",
]);
const BrowserSettingsProviderSchema = z.enum([
	"openai",
	"ollama_cloud",
	"ollama_local",
]);
const BrowserSettingsServiceActionSchema = z.enum([
	"start",
	"stop",
	"restart",
	"install",
	"update",
	"rollback",
]);

export const BrowserSettingsServiceSchema = z
	.object({
		installed: z.boolean(),
		process: z.enum(["running", "stopped", "unknown"]),
		api: z.enum(["ready", "unavailable"]),
		delivery: z.enum([
			"ready",
			"held",
			"pull_only",
			"next_turn",
			"unavailable",
		]),
		actions: z.array(BrowserSettingsServiceActionSchema).max(6),
	})
	.strict();

export const BrowserSettingsRenderSchema = z
	.object({
		target: BrowserSettingsTargetSchema,
		status: z.enum(["clean", "drift", "tamper", "missing", "error"]),
		version: z.string().min(1).max(128).optional(),
		managed_files: z.array(z.string().min(1).max(256)).max(500),
		rollback_available: z.boolean(),
	})
	.strict();

export const BrowserSettingsCapabilitySchema = z
	.object({
		opaque_id: z.string().min(1).max(128),
		harness: BrowserSettingsHarnessSchema,
		backend: BrowserSettingsBackendSchema,
		model_pattern: z.string().min(1).max(256),
		binary: z.enum(["available", "unavailable"]),
		provider: z.enum(["configured", "unconfigured", "not_applicable"]),
		model: z.enum(["supported", "experimental", "unknown", "unsupported"]),
		qualification: z.enum([
			"supported",
			"experimental",
			"unknown",
			"unsupported",
			"stale",
			"registration_only",
			"invalid_evidence",
		]),
		endpoint: z.enum(["healthy", "degraded", "absent"]),
		delivery: z.enum([
			"ready",
			"not_ready",
			"ineligible",
			"pull_only",
			"next_turn",
		]),
		evidence_version: z.string().min(1).max(128).optional(),
		evidence_at: BrowserSettingsTimestampSchema.optional(),
		remedy: BrowserSettingsTextSchema,
	})
	.strict();

export const BrowserSettingsPresetSchema = z
	.object({
		name: z.string().min(1).max(64),
		harness: BrowserSettingsHarnessSchema,
		backend: BrowserSettingsBackendSchema,
		model_selector: z.string().min(1).max(256),
		source: z.enum(["built_in", "user"]),
	})
	.strict();

export const BrowserSettingsProviderSchemaView = z
	.object({
		provider: BrowserSettingsProviderSchema,
		configured: z.boolean(),
		qualification: z.enum([
			"supported",
			"experimental",
			"unknown",
			"unsupported",
		]),
		delivery_ready: z.boolean(),
		rollback_available: z.boolean(),
	})
	.strict();

export const BrowserSettingsMigrationSchema = z
	.object({
		status: z.enum([
			"not_planned",
			"ready",
			"review_required",
			"applied",
			"rolled_back",
			"failed",
		]),
		plan_hash: BrowserSettingsPlanHashSchema.optional(),
		create: z.number().int().nonnegative(),
		attach: z.number().int().nonnegative(),
		review: z.number().int().nonnegative(),
		quarantine: z.number().int().nonnegative(),
		backup_available: z.boolean(),
		rollback_available: z.boolean(),
	})
	.strict();

export const BrowserSettingsAuditSchema = z
	.object({
		command_id: z.string().min(1).max(128),
		command_kind: z.string().min(1).max(128),
		status: z.enum(["pending", "completed", "rejected", "failed"]),
		created_at: BrowserSettingsTimestampSchema,
		completed_at: BrowserSettingsTimestampSchema.optional(),
	})
	.strict();

export const BrowserSettingsSnapshotSchema = z
	.object({
		schema_version: z.literal("golem.browser-settings/v1"),
		revision: z.number().int().nonnegative(),
		service: BrowserSettingsServiceSchema,
		renders: z.array(BrowserSettingsRenderSchema).max(5),
		capabilities: z.array(BrowserSettingsCapabilitySchema).max(100),
		providers: z.array(BrowserSettingsProviderSchemaView).max(3),
		presets: z.array(BrowserSettingsPresetSchema).max(100),
		migration: BrowserSettingsMigrationSchema,
		unknown_config_keys_preserved: z.boolean(),
		unknown_config_key_count: z.number().int().nonnegative().max(10_000),
		audit: z.array(BrowserSettingsAuditSchema).max(50),
	})
	.strict();

const BrowserSettingsCommandBaseSchema = z.object({
	idempotency_key: z.string().min(1).max(256),
});
const BrowserSettingsConfirmedSchema = z.object({
	plan_hash: BrowserSettingsPlanHashSchema,
	confirm: z.literal(true),
});
const BrowserSettingsPresetInputSchema = z
	.object({
		name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
		harness: BrowserSettingsHarnessSchema,
		backend: BrowserSettingsBackendSchema,
		model_selector: z.string().min(1).max(256),
		delivery_mode: BrowserSettingsDeliveryModeSchema,
	})
	.strict();

export const BrowserSettingsCommandRequestSchema = z.discriminatedUnion(
	"kind",
	[
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("render.preview"),
			target: BrowserSettingsTargetSchema,
		}).strict(),
		BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema)
			.extend({
				kind: z.literal("render.apply"),
				target: BrowserSettingsTargetSchema,
			})
			.strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("render.rollback"),
			target: BrowserSettingsTargetSchema,
			confirm: z.literal(true),
		}).strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("service.preview"),
			action: BrowserSettingsServiceActionSchema,
		}).strict(),
		BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema)
			.extend({
				kind: z.literal("service.apply"),
				action: BrowserSettingsServiceActionSchema,
			})
			.strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("provider.preview"),
			provider: BrowserSettingsProviderSchema,
		}).strict(),
		BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema)
			.extend({
				kind: z.literal("provider.apply"),
				provider: BrowserSettingsProviderSchema,
			})
			.strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("provider.rollback"),
			provider: BrowserSettingsProviderSchema,
			confirm: z.literal(true),
		}).strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("preset.preview"),
			preset: BrowserSettingsPresetInputSchema,
		}).strict(),
		BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema)
			.extend({
				kind: z.literal("preset.apply"),
				preset: BrowserSettingsPresetInputSchema,
			})
			.strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("preset.rollback"),
			confirm: z.literal(true),
		}).strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("migration.preview"),
		}).strict(),
		BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema)
			.extend({
				kind: z.literal("migration.apply"),
			})
			.strict(),
		BrowserSettingsCommandBaseSchema.extend({
			kind: z.literal("migration.rollback"),
			confirm: z.literal(true),
		}).strict(),
	],
);

export const BrowserSettingsCommandResultSchema = z
	.object({
		command_kind: z.string().min(1).max(128),
		outcome: z.enum(["previewed", "applied", "rolled_back"]),
		summary: BrowserSettingsTextSchema,
		plan_hash: BrowserSettingsPlanHashSchema.optional(),
		changed: z.boolean(),
		affected: z.array(z.string().min(1).max(256)).max(500),
		rollback_available: z.boolean(),
		snapshot_revision: z.number().int().nonnegative(),
	})
	.strict();

export const BrowserSettingsCommandResponseSchema = z
	.object({
		schema_version: z.literal("golem.browser-settings-command/v1"),
		command_id: z.string().min(1).max(128),
		status: z.enum(["pending", "completed"]),
		result: BrowserSettingsCommandResultSchema.optional(),
	})
	.strict();

export const BrowserSettingsErrorSchema = z
	.object({
		schema_version: z.literal("golem.browser-settings-error/v1"),
		code: z.enum([
			"browser.auth.required",
			"browser.forbidden",
			"browser.settings.invalid",
			"browser.settings.conflict",
			"browser.settings.unavailable",
			"command.idempotency_mismatch",
		]),
		correlation_id: z.string().min(1).max(128),
	})
	.strict();

export type BrowserSettingsSnapshot = z.infer<
	typeof BrowserSettingsSnapshotSchema
>;
export type BrowserSettingsCommandRequest = z.infer<
	typeof BrowserSettingsCommandRequestSchema
>;
export type BrowserSettingsCommandResponse = z.infer<
	typeof BrowserSettingsCommandResponseSchema
>;
export type BrowserSettingsCommandResult = z.infer<
	typeof BrowserSettingsCommandResultSchema
>;
export type BrowserSettingsError = z.infer<typeof BrowserSettingsErrorSchema>;
