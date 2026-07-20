import { z } from "zod";

import { DeliveryModeSchema, HarnessSchema } from "./common.js";
import { JsonValueSchema } from "./json.js";
import { wireVersion } from "./version.js";

const SecretValuePattern =
	/(?:api[_-]?key|token|secret|password|credential)\s*=/iu;

function rejectSecretArguments(
	value: { native_args: string[] },
	context: z.RefinementCtx,
) {
	for (const [index, argument] of value.native_args.entries()) {
		if (SecretValuePattern.test(argument)) {
			context.addIssue({
				code: "custom",
				message: "config.secret_value.forbidden",
				path: ["native_args", index],
			});
		}
	}
}

export const LauncherPresetBodySchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[a-z0-9][a-z0-9-]*$/u),
		harness: HarnessSchema,
		backend: z.enum([
			"openai",
			"anthropic",
			"ollama_local",
			"ollama_cloud",
			"native",
		]),
		model_selector: z.string().min(1).max(256),
		delivery_mode: DeliveryModeSchema,
		native_args: z.array(z.string().min(1).max(1024)).max(32),
		env_key_refs: z
			.array(
				z.string().regex(/^[A-Z][A-Z0-9_]*$/u, "config.env_key_ref.invalid"),
			)
			.max(16),
		binary_override: z.string().min(1).max(4096).optional(),
	})
	.strict()
	.superRefine(rejectSecretArguments);

export const LauncherPresetSchema = z
	.object({
		schema_version: wireVersion("launcher-preset"),
		...LauncherPresetBodySchema.shape,
	})
	.strict()
	.superRefine(rejectSecretArguments);

const HarnessDefaultsSchema = z
	.object({
		claude: z.string().min(1).max(128).optional(),
		codex: z.string().min(1).max(128).optional(),
		opencode: z.string().min(1).max(128).optional(),
		pi: z.string().min(1).max(128).optional(),
	})
	.strict();

export const LauncherConfigV1Schema = z
	.object({
		schema_version: wireVersion("launcher-config"),
		launch: z
			.object({
				harness_defaults: HarnessDefaultsSchema,
				presets: z.array(LauncherPresetBodySchema).max(256),
			})
			.strict(),
	})
	.strict();

/**
 * Only legacy import adapters may use this loose envelope. Canonical config,
 * commands, and signals remain strict and reject unmanaged fields.
 */
export const CompatibilityIngressV1Schema = z
	.object({
		schema_version: wireVersion("compatibility-ingress"),
		legacy_schema_version: z.string().min(1).max(128),
		payload: JsonValueSchema,
	})
	.passthrough();

export type LauncherPreset = z.infer<typeof LauncherPresetSchema>;
export type LauncherConfigV1 = z.infer<typeof LauncherConfigV1Schema>;
export type CompatibilityIngressV1 = z.infer<
	typeof CompatibilityIngressV1Schema
>;
