import { ApiErrorV1Schema, RuntimeSignalKinds } from "@golem/contracts";
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
		runtime: z
			.object({
				inbox: z
					.object({
						pending: z.number().int().nonnegative(),
						processing: z.number().int().nonnegative(),
						archived: z.number().int().nonnegative(),
						quarantined: z.number().int().nonnegative(),
						retrying: z.number().int().nonnegative(),
						oldestPendingAgeMs: z.number().nonnegative().optional(),
						oldestRetryAgeMs: z.number().nonnegative().optional(),
					})
					.strict(),
				outbox: z
					.object({
						pending: z.number().int().nonnegative(),
						claimed: z.number().int().nonnegative(),
						published: z.number().int().nonnegative(),
						permanentFailures: z.number().int().nonnegative(),
						oldestRetryAgeMs: z.number().nonnegative().optional(),
						lastSuccessAt: z.string().datetime().optional(),
					})
					.strict(),
				lastSuccessfulMaterializationAt: z.string().datetime().optional(),
				lastTickError: z.literal("runtime tick deferred").optional(),
			})
			.strict()
			.optional(),
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

export const RuntimeIngestReceiptSchema = z
	.object({
		schema_version: z.literal("golem.runtime-ingest-receipt/v1"),
		event_id: z.string().min(1).max(256),
		status: z.enum(["spooled", "already_pending"]),
	})
	.strict();

/**
 * OpenAPI-safe transport shape for the generated client. The authoritative
 * discriminated payload validation stays in RuntimeSignalV1Schema at the
 * route/materializer boundary; Zod's recursive JSON-value schema is not an
 * OpenAPI component and must not leave dangling $defs in generated clients.
 */
export const RuntimeIngestRequestSchema = z
	.object({
		schema_version: z.literal("golem.runtime-signal/v1"),
		event_id: z.string().min(1).max(256),
		event_kind: z.enum(RuntimeSignalKinds),
		producer: z.string().min(1).max(128),
		producer_instance_id: z.string().min(1).max(256),
		harness: z.enum(["claude", "codex", "opencode", "pi"]),
		producer_sequence: z.number().int().nonnegative().optional(),
		correlation_id: z.string().min(1).max(128),
		causation_id: z.string().min(1).max(256).optional(),
		deduplication_key: z.string().min(1).max(256),
		owner_fence: z.string().min(1).max(256).optional(),
		clocks: z
			.object({
				source_observed_at: z.iso.datetime({ offset: true }),
				source_event_at: z.iso.datetime({ offset: true }).optional(),
				received_at: z.iso.datetime({ offset: true }),
				materialized_at: z.iso.datetime({ offset: true }).optional(),
			})
			.strict(),
		provenance: z
			.object({
				source: z.enum([
					"adapter",
					"api",
					"launcher",
					"legacy_import",
					"migration",
				]),
				evidence_id: z.string().min(1).max(256).optional(),
				confidence: z.enum(["verified", "observed", "inferred", "legacy"]),
			})
			.strict(),
		clear_fields: z.array(z.string().min(1).max(160)).max(64),
		payload: z.record(z.string(), z.unknown()),
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
