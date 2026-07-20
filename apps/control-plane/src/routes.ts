import { RuntimeSignalV1Schema } from "@golem/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { type BrowserSessionAuthority, bearerIsValid } from "./auth.js";
import type { LegacyCompatibilityPublisher } from "./compatibility.js";
import { fail, sendValidated } from "./errors.js";
import { controlPlaneOpenApiDocument } from "./openapi.js";
import type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayPort,
	RuntimeIngressPort,
} from "./ports.js";
import {
	ApiErrorResponseJsonSchema,
	BrowserEchoBodySchema,
	BrowserEchoResponseSchema,
	BrowserSessionResponseSchema,
	ControlPlaneStreams,
	HealthResponseSchema,
	MetaResponseSchema,
	OpenApiDocumentSchema,
	ProjectionParamsSchema,
	ProjectionResponseSchema,
	RuntimeIngestReceiptSchema,
	RuntimeIngestRequestSchema,
} from "./schemas.js";

function jsonSchema(value: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(value, {
		// Fastify's built-in validator is draft-07; the generated OpenAPI document
		// keeps its independent 2020-12 representation in openapi.ts.
		target: "draft-7",
		unrepresentable: "any",
		reused: "inline",
	}) as Record<string, unknown>;
}

function requireBearer(
	request: FastifyRequest,
	reply: FastifyReply,
	token: string,
): boolean {
	if (bearerIsValid(request, token)) return true;
	fail(request, reply, 401, "auth.invalid", "a valid bearer token is required");
	return false;
}

export function registerValidatedRoutes(options: {
	readonly app: FastifyInstance;
	readonly token: string;
	readonly instanceId: string;
	readonly projection: ControlPlaneProjectionPort;
	readonly replay: ControlPlaneReplayPort;
	readonly legacy: LegacyCompatibilityPublisher;
	readonly sessions: BrowserSessionAuthority;
	readonly runtimeIngress?: RuntimeIngressPort;
	readonly invalidResponseForTest?: boolean;
}): void {
	const responseSchemas = {
		400: ApiErrorResponseJsonSchema,
		401: ApiErrorResponseJsonSchema,
		403: ApiErrorResponseJsonSchema,
		409: ApiErrorResponseJsonSchema,
		500: ApiErrorResponseJsonSchema,
		503: ApiErrorResponseJsonSchema,
	};

	options.app.get(
		"/api/v1/health/live",
		{
			schema: {
				response: { 200: jsonSchema(HealthResponseSchema), ...responseSchemas },
			},
		},
		async (request, reply) =>
			sendValidated(
				request,
				reply,
				HealthResponseSchema,
				options.invalidResponseForTest
					? {
							schema_version: "golem.control-plane-health/v1",
							status: "invalid",
						}
					: {
							schema_version: "golem.control-plane-health/v1",
							status: "live",
							instance_id: options.instanceId,
						},
			),
	);

	options.app.get(
		"/api/v1/health/ready",
		{
			schema: {
				response: { 200: jsonSchema(HealthResponseSchema), ...responseSchemas },
			},
		},
		async (request, reply) => {
			if (!requireBearer(request, reply, options.token)) return;
			return sendValidated(request, reply, HealthResponseSchema, {
				schema_version: "golem.control-plane-health/v1",
				status: "ready",
				instance_id: options.instanceId,
			});
		},
	);

	options.app.get(
		"/api/v1/meta",
		{
			schema: {
				response: { 200: jsonSchema(MetaResponseSchema), ...responseSchemas },
			},
		},
		async (request, reply) => {
			if (!requireBearer(request, reply, options.token)) return;
			return sendValidated(request, reply, MetaResponseSchema, {
				schema_version: "golem.control-plane-meta/v1",
				instance_id: options.instanceId,
				service: "control-plane",
				projections: ControlPlaneStreams,
			});
		},
	);

	options.app.get(
		"/api/v1/openapi.json",
		{
			schema: {
				response: {
					200: jsonSchema(OpenApiDocumentSchema),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			if (!requireBearer(request, reply, options.token)) return;
			return sendValidated(
				request,
				reply,
				OpenApiDocumentSchema,
				controlPlaneOpenApiDocument(),
			);
		},
	);

	options.app.get(
		"/api/v1/projections/:stream",
		{
			schema: {
				params: jsonSchema(ProjectionParamsSchema),
				response: {
					200: jsonSchema(ProjectionResponseSchema),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			if (!requireBearer(request, reply, options.token)) return;
			const parsed = ProjectionParamsSchema.safeParse(request.params);
			if (!parsed.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"projection stream is invalid",
				);
			const stream = parsed.data.stream;
			return sendValidated(request, reply, ProjectionResponseSchema, {
				schema_version: "golem.control-plane-projection/v1",
				stream,
				resource_revision: options.projection.revision(stream),
				payload: options.projection.read(stream),
			});
		},
	);

	options.app.post(
		"/api/v1/runtime/events",
		{
			schema: {
				body: jsonSchema(RuntimeIngestRequestSchema),
				response: {
					202: jsonSchema(RuntimeIngestReceiptSchema),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			if (!requireBearer(request, reply, options.token)) return;
			if (!options.runtimeIngress)
				return fail(
					request,
					reply,
					503,
					"runtime.unavailable",
					"durable runtime ingress is not composed",
				);
			const parsed = RuntimeSignalV1Schema.safeParse(request.body);
			if (!parsed.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"runtime signal is invalid or uses an unsupported schema version",
				);
			const receipt = options.runtimeIngress.ingest(parsed.data);
			return sendValidated(
				request,
				reply.code(202),
				RuntimeIngestReceiptSchema,
				{
					schema_version: "golem.runtime-ingest-receipt/v1",
					event_id: receipt.eventId,
					status: receipt.status,
				},
			);
		},
	);

	options.app.post(
		"/api/v1/browser/session",
		{
			schema: {
				response: {
					200: jsonSchema(BrowserSessionResponseSchema),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			if (!requireBearer(request, reply, options.token)) return;
			const session = options.sessions.create();
			reply.header("set-cookie", session.setCookie);
			return sendValidated(request, reply, BrowserSessionResponseSchema, {
				schema_version: "golem.control-plane-browser-session/v1",
				csrf_token: session.csrf,
			});
		},
	);

	options.app.post(
		"/api/v1/browser/echo",
		{
			schema: {
				body: jsonSchema(BrowserEchoBodySchema),
				response: {
					200: jsonSchema(BrowserEchoResponseSchema),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			const bearer = bearerIsValid(request, options.token);
			if (!bearer && !options.sessions.validMutation(request))
				return fail(
					request,
					reply,
					403,
					"csrf.invalid",
					"a same-origin browser session and CSRF token are required",
				);
			const parsed = BrowserEchoBodySchema.safeParse(request.body);
			if (!parsed.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"browser echo body is invalid",
				);
			try {
				options.replay.publish(
					"runtime.live",
					options.projection.revision("runtime.live"),
					{
						kind: "browser_echoed",
						value: parsed.data.value,
						transport: bearer ? "bearer" : "browser",
					},
				);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes("resource revision must not regress")
				)
					return fail(
						request,
						reply,
						409,
						"revision.regressed",
						"canonical resource revision regressed",
					);
				throw error;
			}
			options.legacy.publish({
				type: "projects-list",
				projects: [
					{
						id: "control-plane-browser-echo",
						name: parsed.data.value,
						path: null,
						phase: "drafting",
					},
				],
			});
			return sendValidated(request, reply, BrowserEchoResponseSchema, {
				schema_version: "golem.control-plane-browser-echo/v1",
				value: parsed.data.value,
			});
		},
	);
}
