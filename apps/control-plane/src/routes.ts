import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { type BrowserSessionAuthority, bearerIsValid } from "./auth.js";
import { fail, sendValidated } from "./errors.js";
import { controlPlaneOpenApiDocument } from "./openapi.js";
import type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayPort,
} from "./ports.js";
import {
	BrowserEchoBodySchema,
	BrowserEchoResponseSchema,
	BrowserSessionResponseSchema,
	ControlPlaneStreams,
	HealthResponseSchema,
	MetaResponseSchema,
	OpenApiDocumentSchema,
	ProjectionParamsSchema,
	ProjectionResponseSchema,
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
	readonly sessions: BrowserSessionAuthority;
	readonly invalidResponseForTest?: boolean;
}): void {
	const responseSchemas = {
		400: jsonSchema(z.object({}).passthrough()),
		401: jsonSchema(z.object({}).passthrough()),
		403: jsonSchema(z.object({}).passthrough()),
		500: jsonSchema(z.object({}).passthrough()),
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
			options.replay.publish(
				"runtime.live",
				options.projection.revision("runtime.live"),
				{
					kind: "browser_echoed",
					value: parsed.data.value,
					transport: bearer ? "bearer" : "browser",
				},
			);
			return sendValidated(request, reply, BrowserEchoResponseSchema, {
				schema_version: "golem.control-plane-browser-echo/v1",
				value: parsed.data.value,
			});
		},
	);
}
