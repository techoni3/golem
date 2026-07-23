import {
	BrowserWorkProjectionResponseSchema,
	BrowserWorkProjectionQuerySchema,
	BrowserWorkStreamSchema,
	RuntimeSignalV1Schema,
} from "@golem/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
	isExpectedOrigin,
} from "./auth.js";
import type { LegacyCompatibilityPublisher } from "./compatibility.js";
import { fail, sendValidated } from "./errors.js";
import { controlPlaneOpenApiDocument } from "./openapi.js";
import type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayPort,
	RuntimeHealthPort,
	RuntimeIngressPort,
	RuntimeProjectionPort,
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
	RuntimeProjectionQuerySchema,
	RuntimeProjectionResponseSchema,
} from "./schemas.js";
import type { BrowserWorkServices } from "./browser-work-services.js";

function jsonSchema(value: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(value, {
		// Fastify's built-in validator is draft-07; the generated OpenAPI document
		// keeps its independent 2020-12 representation in openapi.ts.
		target: "draft-7",
		unrepresentable: "any",
		reused: "inline",
	}) as Record<string, unknown>;
}

function requirePrincipal(
	request: FastifyRequest,
	reply: FastifyReply,
	principal: BrowserPrincipalResolver,
	action: "read" | "mutate",
	allowBrowser: boolean,
): boolean {
	if (hasRequestAuthorityOverride(request)) {
		fail(
			request,
			reply,
			403,
			"browser.forbidden",
			"request authority is server-owned",
		);
		return false;
	}
	const context = principal.resolve(request, {
		action,
		allowBrowser,
		allowBearer: true,
	});
	if (!context) {
		fail(
			request,
			reply,
			401,
			"browser.auth.required",
			"an authenticated principal binding is required",
		);
		return false;
	}
	if (!principal.policy.allows(context, action)) {
		fail(
			request,
			reply,
			403,
			"browser.forbidden",
			"the authenticated principal is not authorized",
		);
		return false;
	}
	return true;
}

function requireBearer(
	request: FastifyRequest,
	reply: FastifyReply,
	principal: BrowserPrincipalResolver,
): boolean {
	if (requirePrincipal(request, reply, principal, "read", false)) return true;
	return false;
}

/** Browser reads require the durable cookie plus exact same-origin provenance;
 * CSRF is additionally required for browser mutations. */
function requireBrowserRead(
	request: FastifyRequest,
	reply: FastifyReply,
	principal: BrowserPrincipalResolver,
): boolean {
	return requirePrincipal(request, reply, principal, "read", true);
}

export function registerValidatedRoutes(options: {
	readonly app: FastifyInstance;
	readonly token: string;
	readonly instanceId: string;
	readonly projection: ControlPlaneProjectionPort;
	readonly runtimeProjection?: RuntimeProjectionPort;
	readonly replay: ControlPlaneReplayPort;
	readonly legacy: LegacyCompatibilityPublisher;
	readonly principal: BrowserPrincipalResolver;
	readonly runtimeIngress?: RuntimeIngressPort;
	readonly runtimeHealth?: RuntimeHealthPort;
	/** Optional until GOL-81 browser-work composition is present. */
	readonly browserWork?: BrowserWorkServices;
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
		"/api/v1/runtime/:stream",
		{
			schema: {
				params: jsonSchema(
					z.object({
						stream: z.enum(["live", "history", "diagnostics"]),
					}),
				),
				querystring: jsonSchema(RuntimeProjectionQuerySchema),
				response: {
					200: jsonSchema(RuntimeProjectionResponseSchema),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			if (!requireBrowserRead(request, reply, options.principal)) return;
			if (!options.runtimeProjection)
				return fail(
					request,
					reply,
					503,
					"runtime.projection_unavailable",
					"runtime projections are not composed",
				);
			const params = request.params as { readonly stream?: string };
			const runtimeStream =
				params.stream === "live"
					? "runtime.live"
					: params.stream === "history"
						? "runtime.history"
						: params.stream === "diagnostics"
							? "runtime.diagnostics"
							: undefined;
			if (!runtimeStream)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"runtime projection stream is invalid",
				);
			const queryResult = RuntimeProjectionQuerySchema.safeParse(request.query);
			if (!queryResult.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"runtime projection query is invalid",
				);
			try {
				const payload = options.runtimeProjection.query(runtimeStream, {
					...(queryResult.data.project_id
						? { projectId: queryResult.data.project_id }
						: {}),
					...(queryResult.data.cursor === undefined
						? {}
						: { cursor: queryResult.data.cursor }),
					...(queryResult.data.limit === undefined
						? {}
						: { limit: queryResult.data.limit }),
					...(queryResult.data.state ? { state: queryResult.data.state } : {}),
				});
				return sendValidated(
					request,
					reply,
					RuntimeProjectionResponseSchema,
					payload,
				);
			} catch (error) {
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					error instanceof Error
						? error.message
						: "runtime projection query is invalid",
				);
			}
		},
	);

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
							...(options.runtimeHealth
								? { runtime: options.runtimeHealth.health() }
								: {}),
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
			if (!requireBearer(request, reply, options.principal)) return;
			return sendValidated(request, reply, HealthResponseSchema, {
				schema_version: "golem.control-plane-health/v1",
				status: "ready",
				instance_id: options.instanceId,
				...(options.runtimeHealth
					? { runtime: options.runtimeHealth.health() }
					: {}),
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
			if (!requireBrowserRead(request, reply, options.principal)) return;
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
			if (!requireBearer(request, reply, options.principal)) return;
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
				querystring: jsonSchema(BrowserWorkProjectionQuerySchema),
				response: {
					200: jsonSchema(
						z.union([
							ProjectionResponseSchema,
							BrowserWorkProjectionResponseSchema,
						]),
					),
					...responseSchemas,
				},
			},
		},
		async (request, reply) => {
			const parsed = ProjectionParamsSchema.safeParse(request.params);
			if (!parsed.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"projection stream is invalid",
				);
			const browserStream = BrowserWorkStreamSchema.safeParse(parsed.data.stream);
			if (browserStream.success && options.browserWork) {
				const query = BrowserWorkProjectionQuerySchema.safeParse(request.query);
				if (!query.success)
					return fail(
						request,
						reply,
						400,
						"request.invalid",
						"projection cursor is invalid",
					);
				if (hasRequestAuthorityOverride(request))
					return fail(
						request,
						reply,
						403,
						"browser.forbidden",
						"request authority is server-owned",
					);
				const context = options.principal.resolve(request, {
					action: "read",
					allowBrowser: true,
					allowBearer: false,
				});
				if (!context)
					return fail(
						request,
						reply,
						401,
						"browser.auth.required",
						"an authenticated browser session is required",
					);
				if (!options.principal.policy.allows(context, "read"))
					return fail(
						request,
						reply,
						403,
						"browser.forbidden",
						"the authenticated principal is not authorized",
					);
				return reply.send(
					options.browserWork.projection(
						browserStream.data,
						context.defaultProjectId,
						query.data.cursor,
					),
				);
			}
			if (!requireBrowserRead(request, reply, options.principal)) return;
			const context = options.principal.resolve(request, {
				action: "read",
				allowBrowser: true,
				allowBearer: true,
			});
			if (!context)
				return fail(
					request,
					reply,
					401,
					"browser.auth.required",
					"an authenticated principal binding is required",
				);
			const stream = parsed.data.stream;
			return sendValidated(request, reply, ProjectionResponseSchema, {
				schema_version: "golem.control-plane-projection/v1",
				stream,
				resource_revision: options.projection.revision(
					stream,
					context.defaultProjectId,
				),
				payload: options.projection.read(stream, context.defaultProjectId),
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
			if (!requirePrincipal(request, reply, options.principal, "mutate", false))
				return;
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
			// The static SPA cannot receive the service bearer. A same-origin POST
			// is the explicit bootstrap boundary that mints its HttpOnly session;
			// subsequent browser mutations still require that session plus CSRF.
			if (hasRequestAuthorityOverride(request))
				return fail(
					request,
					reply,
					403,
					"browser.forbidden",
					"request authority is server-owned",
				);
			if (!isExpectedOrigin(request.headers.origin, request))
				return fail(
					request,
					reply,
					401,
					"browser.auth.required",
					"an enabled local browser binding is required",
				);
			const session = options.principal.bootstrap(request);
			if (!session.ok)
				return fail(
					request,
					reply,
					401,
					"browser.auth.required",
					"an enabled local browser binding is required",
				);
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
			if (!requirePrincipal(request, reply, options.principal, "mutate", true))
				return;
			const context = options.principal.resolve(request, {
				action: "mutate",
				allowBrowser: true,
				allowBearer: true,
			});
			const bearer = context?.source === "bearer";
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
