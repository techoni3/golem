import { z } from "zod";

import { JsonValueSchema } from "./json.js";

/**
 * Pre-GOL-81 generic projections remain available to the existing runtime
 * client. Browser-work streams deliberately have their own concrete schema.
 */
export const LegacyControlPlaneProjectionStreamSchema = z.enum([
	"runtime.live",
	"runtime.history",
	"runtime.diagnostics",
	"projects",
]);

export const LegacyControlPlaneProjectionResponseSchema = z
	.object({
		schema_version: z.literal("golem.control-plane-projection/v1"),
		stream: LegacyControlPlaneProjectionStreamSchema,
		resource_revision: z.number().int().nonnegative(),
		payload: JsonValueSchema,
	})
	.strict();

export type LegacyControlPlaneProjectionResponse = z.infer<
	typeof LegacyControlPlaneProjectionResponseSchema
>;
