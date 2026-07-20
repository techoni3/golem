import { ApiErrorV1Schema } from "@golem/contracts";
import { z } from "zod";

export const ApiErrorResponseSchema = ApiErrorV1Schema;

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
		stream: z.enum([
			"runtime.live",
			"runtime.history",
			"runtime.diagnostics",
			"projects",
			"tracker.tree",
			"tracker.board",
			"communication.operations",
		]),
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

export type ControlPlaneStream = z.infer<
	typeof ProjectionParamsSchema
>["stream"];
