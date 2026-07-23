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

export const ApiCommandOutcomeStatusV1Schema = z.enum([
	"accepted",
	"completed",
	"rejected",
	"conflict",
	"pending",
	"idempotency_mismatch",
]);
export type ApiCommandOutcomeStatusV1 = z.infer<
	typeof ApiCommandOutcomeStatusV1Schema
>;

export const ApiCommandOutcomeV1Schema = z
	.object({
		schema_version: wireVersion("api-command-outcome"),
		command_id: CommandIdSchema,
		status: ApiCommandOutcomeStatusV1Schema,
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

/**
 * Durable command receipt.  The canonical record persisted by
 * {@link CommandGateway} in the same tracker transaction as the domain
 * mutation.  It carries the actor/policy binding reference, project/resource
 * scope, request fingerprint, correlation id, terminal typed outcome, and
 * committed-at timestamp — but never bearer/cookie/CSRF, raw prompt, fence
 * token, or storage path (see GOL-79 migration/rollback constraints).
 */
export const CommandReceiptV1Schema = z
	.object({
		schema_version: wireVersion("command-receipt"),
		command_id: CommandIdSchema,
		idempotency_key: z.string().min(1).max(256),
		command_kind: z.string().min(1).max(128),
		actor_id: z.string().min(1).max(256),
		project_id: z.string().min(1).max(256),
		resource_type: z.string().min(1).max(64),
		resource_id: z.string().min(1).max(256),
		correlation_id: z.string().min(1).max(128),
		fingerprint: z.string().min(1).max(128),
		outcome: ApiCommandOutcomeV1Schema,
		committed_at: z.string().min(1).max(64),
	})
	.strict();

/**
 * Stable request fingerprint input.  The gateway hashes a canonical JSON of
 * command kind + payload + project/resource scope to detect a reuse of an
 * idempotency key with a differing request.  The fingerprint itself is stored
 * in the receipt; the input is never persisted verbatim.
 */
export const CommandFingerprintInputV1Schema = z
	.object({
		command_kind: z.string().min(1).max(128),
		project_id: z.string().min(1).max(256),
		resource_type: z.string().min(1).max(64),
		resource_id: z.string().min(1).max(256),
		payload: JsonValueSchema,
	})
	.strict();

export type ApiErrorV1 = z.infer<typeof ApiErrorV1Schema>;
export type ApiCommandOutcomeV1 = z.infer<typeof ApiCommandOutcomeV1Schema>;
export type ApiPageV1 = z.infer<typeof ApiPageV1Schema>;
export type CommandReceiptV1 = z.infer<typeof CommandReceiptV1Schema>;
export type CommandFingerprintInputV1 = z.infer<
	typeof CommandFingerprintInputV1Schema
>;
