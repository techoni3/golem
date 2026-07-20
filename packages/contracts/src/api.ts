import { z } from "zod";

import { CommandIdSchema, OperationIdSchema } from "./ids.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";
import { wireVersion } from "./version.js";

export const ApiErrorV1Schema = z
	.object({
		schema_version: wireVersion("api-error"),
		code: z.string().min(1).max(128),
		message: z.string().min(1).max(1024),
		correlation_id: z.string().min(1).max(128),
		details: JsonObjectSchema.optional(),
	})
	.strict();

export const ApiCommandOutcomeV1Schema = z
	.object({
		schema_version: wireVersion("api-command-outcome"),
		command_id: CommandIdSchema,
		status: z.enum([
			"accepted",
			"completed",
			"rejected",
			"conflict",
			"pending",
		]),
		reason_code: z.string().min(1).max(128).optional(),
		operation_id: OperationIdSchema.optional(),
		result: JsonValueSchema.optional(),
	})
	.strict();

export const ApiPageV1Schema = z
	.object({
		schema_version: wireVersion("api-page"),
		items: z.array(JsonValueSchema),
		next_cursor: z.string().min(1).max(512).nullable(),
		total: z.number().int().nonnegative().optional(),
	})
	.strict();

export type ApiErrorV1 = z.infer<typeof ApiErrorV1Schema>;
export type ApiCommandOutcomeV1 = z.infer<typeof ApiCommandOutcomeV1Schema>;
export type ApiPageV1 = z.infer<typeof ApiPageV1Schema>;
