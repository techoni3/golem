import { ApiErrorV1Schema } from "@golem/contracts";
import { z } from "zod";

export const ApiErrorResponseSchema = ApiErrorV1Schema;

/**
 * Fastify draft-07 and OpenAPI 3.1 share this non-recursive JSON projection.
 * The Zod contract remains authoritative for runtime parsing; `details` is a
 * JSON object, whose values are already constrained to JSON by transport.
 */
export const ApiErrorResponseJsonSchema: Readonly<Record<string, unknown>> =
	Object.freeze({
		type: "object",
		additionalProperties: false,
		required: ["schema_version", "code", "message", "correlation_id"],
		properties: {
			schema_version: { type: "string", const: "golem.api-error/v1" },
			code: { type: "string", minLength: 1, maxLength: 128 },
			message: { type: "string", minLength: 1, maxLength: 1024 },
			correlation_id: { type: "string", minLength: 1, maxLength: 128 },
			details: {
				type: "object",
				propertyNames: { type: "string" },
				additionalProperties: true,
			},
		},
	});

export const ControlPlaneStreams = [
	"runtime.live",
	"runtime.history",
	"runtime.diagnostics",
	"projects",
	"tracker.tree",
	"tracker.board",
	"communication.operations",
] as const;

export const HealthResponseSchema = z
	.object({
		schema_version: z.literal("golem.control-plane-health/v1"),
		status: z.enum(["live", "ready"]),
		instance_id: z.string().regex(/^cpi_[0-9a-f-]{36}$/iu),
	})
	.strict();

export const MetaResponseSchema = z
	.object({
		schema_version: z.literal("golem.control-plane-meta/v1"),
		instance_id: z.string().regex(/^cpi_[0-9a-f-]{36}$/iu),
		service: z.literal("control-plane"),
		projections: z.array(z.string()).max(16),
	})
	.strict();

export const ProjectionParamsSchema = z
	.object({
		stream: z.enum(ControlPlaneStreams),
	})
	.strict();

export const ProjectionResponseSchema = z
	.object({
		schema_version: z.literal("golem.control-plane-projection/v1"),
		stream: ProjectionParamsSchema.shape.stream,
		resource_revision: z.number().int().nonnegative(),
		payload: z.record(z.string(), z.unknown()),
	})
	.strict();

export const BrowserSessionResponseSchema = z
	.object({
		schema_version: z.literal("golem.control-plane-browser-session/v1"),
		csrf_token: z.string().min(24).max(256),
	})
	.strict();

export const BrowserEchoBodySchema = z
	.object({ value: z.string().min(1).max(256) })
	.strict();

export const BrowserEchoResponseSchema = z
	.object({
		schema_version: z.literal("golem.control-plane-browser-echo/v1"),
		value: z.string().min(1).max(256),
	})
	.strict();

export const OpenApiDocumentSchema = z
	.object({
		openapi: z.literal("3.1.1"),
		info: z.object({ title: z.string(), version: z.string() }).strict(),
		paths: z.record(z.string(), z.unknown()),
	})
	.passthrough();

export type ControlPlaneStream = z.infer<
	typeof ProjectionParamsSchema
>["stream"];
