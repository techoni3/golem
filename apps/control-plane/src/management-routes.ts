import crypto from "node:crypto";

import type { TrackerManagementAsset } from "@golem/persistence";
import {
	type CommandGateway,
	type CommandGatewayInput,
	TrackerManagementError,
	type TrackerManagementServices,
} from "@golem/tracker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
	type ActorContext,
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
} from "./auth.js";
import { fail, sendValidated } from "./errors.js";

const responseSchema = z
	.object({
		schema_version: z.literal("golem.management/v1"),
		result: z.unknown(),
	})
	.passthrough();
const requestSchema = z.record(z.string(), z.unknown());
const errorResponses = {
	400: { type: "object", additionalProperties: true },
	401: { type: "object", additionalProperties: true },
	403: { type: "object", additionalProperties: true },
	404: { type: "object", additionalProperties: true },
	409: { type: "object", additionalProperties: true },
	500: { type: "object", additionalProperties: true },
};

function jsonSchema(value: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(value, {
		target: "draft-7",
		unrepresentable: "any",
		reused: "inline",
	}) as Record<string, unknown>;
}

function authorized(
	request: FastifyRequest,
	reply: FastifyReply,
	principal: BrowserPrincipalResolver,
): ActorContext | undefined {
	if (hasRequestAuthorityOverride(request)) {
		fail(
			request,
			reply,
			403,
			"browser.forbidden",
			"request authority is server-owned",
		);
		return undefined;
	}
	const action = request.method === "GET" ? "read" : "mutate";
	const context = principal.resolve(request, {
		action,
		allowBrowser: true,
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
		return undefined;
	}
	if (!principal.policy.allows(context, action)) {
		fail(
			request,
			reply,
			403,
			"browser.forbidden",
			"the authenticated principal is not authorized",
		);
		return undefined;
	}
	return context;
}

function managementFailure(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
): void {
	if (error instanceof TrackerManagementError) {
		const status =
			error.code === "management.not_found"
				? 404
				: error.code === "management.forbidden"
					? 403
					: error.code === "management.conflict"
						? 409
						: 400;
		fail(request, reply, status, error.code, error.message);
		return;
	}
	fail(request, reply, 500, "management.failed", "management operation failed");
}

function sendResult(
	request: FastifyRequest,
	reply: FastifyReply,
	result: unknown,
) {
	return sendValidated(request, reply, responseSchema, {
		schema_version: "golem.management/v1",
		result,
	});
}

function publicAsset(asset: TrackerManagementAsset) {
	const { storagePath: _storagePath, ...safe } = asset;
	return safe;
}

function body(request: FastifyRequest): Record<string, unknown> {
	const parsed = requestSchema.safeParse(request.body);
	if (!parsed.success)
		throw new TrackerManagementError(
			"management.invalid",
			"request body must be an object",
		);
	return parsed.data;
}

function text(value: unknown, name: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 16_384
	)
		throw new TrackerManagementError(
			"management.invalid",
			`${name} is invalid`,
		);
	return value.trim();
}

function field(input: Record<string, unknown>, name: string): string {
	return text(input[name], name);
}

export function registerManagementRoutes(options: {
	readonly app: FastifyInstance;
	readonly principal: BrowserPrincipalResolver;
	readonly management: TrackerManagementServices;
	readonly gateway?: CommandGateway;
}): void {
	const gateway = options.gateway;

	const GATEWAY_MISMATCH = Symbol("gateway.mismatch");

	/**
	 * Route a management mutation through the gateway when one is composed,
	 * preserving the `golem.management/v1` wire shape.  Returns the handler
	 * result (which may be `undefined`) wrapped in a sentinel so the caller
	 * can distinguish "gateway handled" from "no gateway present".  Returns
	 * `GATEWAY_MISMATCH` on a 409 (already sent to the reply).  The actor id
	 * and project id come from the resolver-created `ActorContext`, never
	 * from the request body/query.
	 */
	function gatewayRoute(input: {
		readonly request: FastifyRequest;
		readonly reply: FastifyReply;
		readonly context: ActorContext;
		readonly commandKind: string;
		readonly scope: CommandGatewayInput["scope"];
		readonly payload: Readonly<Record<string, unknown>>;
		readonly idempotencyKey?: string;
		readonly handler: () => unknown;
	}): { readonly handled: true; readonly result: unknown } | typeof GATEWAY_MISMATCH | undefined {
		if (!gateway) return undefined;
		const key =
			typeof input.idempotencyKey === "string" && input.idempotencyKey
				? input.idempotencyKey
				: `auto:management:${input.commandKind}:${crypto.randomUUID()}`;
		const outcome = gateway.execute({
			commandId: `cmd_${crypto.randomUUID()}`,
			idempotencyKey: key,
			commandKind: input.commandKind,
			actorId: input.context.actorId,
			projectId: input.context.defaultProjectId,
			correlationId: `cor_${crypto.randomUUID()}`,
			scope: input.scope,
			payload: input.payload,
			handler: input.handler,
		});
		if (outcome.status === "idempotency_mismatch") {
			fail(
				input.request,
				input.reply,
				409,
				"command.idempotency_mismatch",
				"idempotency key reused with a differing payload",
			);
			return GATEWAY_MISMATCH;
		}
		return { handled: true as const, result: outcome.result };
	}

	/**
	 * Route a management mutation through the gateway when one is composed,
	 * preserving the `golem.management/v1` wire shape.  When no gateway is
	 * present, fall back to the direct service call.  Uses an explicit
	 * handled sentinel so a gateway-backed handler that legitimately
	 * returns `undefined` does not trigger a second (un-gated) execution.
	 */
	function managementRoute(input: {
		readonly request: FastifyRequest;
		readonly reply: FastifyReply;
		readonly context: ActorContext;
		readonly commandKind: string;
		readonly scope: CommandGatewayInput["scope"];
		readonly payload: Readonly<Record<string, unknown>>;
		readonly idempotencyKey?: string;
		readonly handler: () => unknown;
	}): unknown {
		const routed = gatewayRoute(input);
		if (routed === GATEWAY_MISMATCH) return undefined;
		if (routed !== undefined) return routed.result;
		return input.handler();
	}
	const schema = {
		response: {
			200: jsonSchema(responseSchema),
			201: jsonSchema(responseSchema),
			400: errorResponses[400],
			401: errorResponses[401],
			403: errorResponses[403],
			404: errorResponses[404],
			409: errorResponses[409],
			500: errorResponses[500],
		},
	};
	const register = (
		method: "get" | "post",
		route: string,
		handler: (
			request: FastifyRequest,
			reply: FastifyReply,
			context: ActorContext,
		) => Promise<unknown> | unknown,
		withBody = false,
	) => {
		const routeSchema = withBody
			? { ...schema, body: jsonSchema(requestSchema) }
			: schema;
		options.app[method](
			route,
			{ schema: routeSchema },
			async (request, reply) => {
				const context = authorized(request, reply, options.principal);
				if (!context) return;
				try {
					return await handler(request, reply, context);
				} catch (error) {
					managementFailure(request, reply, error);
				}
			},
		);
	};

	register("get", "/api/v1/management/roles", (_request, reply, context) => {
		return sendResult(
			_request,
			reply,
			options.management.roles.list(context.defaultProjectId),
		);
	});
	register(
		"post",
		"/api/v1/management/roles",
		(request, reply, context) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.role.create",
					scope: { resourceType: "role", resourceId: "*" },
					payload: input,
					handler: () =>
						options.management.roles.create({
							projectId: context.defaultProjectId,
							name: field(input, "name"),
							scope: input.scope as never,
							definition: (input.definition ?? {}) as never,
							actor: context.actorId,
						}),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/roles/:role_id/assign",
		(request, reply, context) => {
			const input = body(request);
			const params = request.params as { role_id: string };
			return sendResult(
				request,
				reply,
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.role.assign",
					scope: { resourceType: "role", resourceId: params.role_id },
					payload: input,
					idempotencyKey: field(input, "idempotency_key"),
					handler: () =>
						options.management.roles.assign({
							projectId: context.defaultProjectId,
							roleId: params.role_id,
							...(input.session_id === undefined
								? {}
								: { sessionId: field(input, "session_id") }),
							...(input.generation_id === undefined
								? {}
								: { generationId: field(input, "generation_id") }),
							actor: context.actorId,
							idempotencyKey: field(input, "idempotency_key"),
						}),
				}),
			);
		},
		true,
	);

	register("get", "/api/v1/management/gates", (_request, reply, context) => {
		return sendResult(
			_request,
			reply,
			options.management.gates.list(context.defaultProjectId),
		);
	});
	register(
		"post",
		"/api/v1/management/gates",
		(request, reply, context) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.gate.create",
					scope: { resourceType: "gate", resourceId: "*" },
					payload: input,
					idempotencyKey: field(input, "idempotency_key"),
					handler: () =>
						options.management.gates.create({
							projectId: context.defaultProjectId,
							kind: input.kind as never,
							question: field(input, "question"),
							assignee: field(input, "assignee"),
							idempotencyKey: field(input, "idempotency_key"),
							actor: context.actorId,
						}),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/gates/:gate_id/verdict",
		(request, reply, context) => {
			const input = body(request);
			const params = request.params as { gate_id: string };
			return sendResult(
				request,
				reply,
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.gate.answer",
					scope: { resourceType: "gate", resourceId: params.gate_id },
					payload: input,
					handler: () =>
						options.management.gates.answer({
							projectId: context.defaultProjectId,
							gateId: params.gate_id,
							status: input.status as never,
							verdict: (input.verdict ?? {}) as never,
							actor: context.actorId,
						}),
				}),
			);
		},
		true,
	);

	register("get", "/api/v1/management/ideas", (_request, reply, context) => {
		return sendResult(
			_request,
			reply,
			options.management.ideas.list(context.defaultProjectId),
		);
	});
	register(
		"post",
		"/api/v1/management/ideas",
		(request, reply, context) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.idea.create",
					scope: { resourceType: "idea", resourceId: "*" },
					payload: input,
					idempotencyKey: field(input, "idempotency_key"),
					handler: () =>
						options.management.ideas.create({
							projectId: context.defaultProjectId,
							body: field(input, "body"),
							idempotencyKey: field(input, "idempotency_key"),
							actor: context.actorId,
						}),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/ideas/:idea_id/pop",
		(request, reply, context) => {
			const input = body(request);
			const params = request.params as { idea_id: string };
			return sendResult(
				request,
				reply,
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.idea.pop",
					scope: { resourceType: "idea", resourceId: params.idea_id },
					payload: input,
					handler: () =>
						options.management.ideas.pop({
							projectId: context.defaultProjectId,
							ideaId: params.idea_id,
							actor: context.actorId,
						}),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/ideas/:idea_id/promote",
		(request, reply, context) => {
			const input = body(request);
			const params = request.params as { idea_id: string };
			return sendResult(
				request,
				reply,
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.idea.promote",
					scope: { resourceType: "idea", resourceId: params.idea_id },
					payload: input,
					handler: () =>
						options.management.ideas.promote({
							projectId: context.defaultProjectId,
							ideaId: params.idea_id,
							actor: context.actorId,
							...(input.title === undefined
								? {}
								: { title: field(input, "title") }),
						}),
				}),
			);
		},
		true,
	);

	register(
		"post",
		"/api/v1/management/communications",
		(request, reply, context) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.communication.create",
					scope: { resourceType: "communication", resourceId: "*" },
					payload: input,
					idempotencyKey: field(input, "idempotency_key"),
					handler: () =>
						options.management.communications.create({
							projectId: context.defaultProjectId,
							kind: input.kind as never,
							command: field(input, "command"),
							payload: (input.payload ?? {}) as never,
							...(input.session_id === undefined
								? {}
								: { sessionId: field(input, "session_id") }),
							...(input.generation_id === undefined
								? {}
								: { generationId: field(input, "generation_id") }),
							actor: context.actorId,
							idempotencyKey: field(input, "idempotency_key"),
						}),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/control",
		(request, reply, context) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				managementRoute({
					request,
					reply,
					context,
					commandKind: "management.control.request",
					scope: { resourceType: "control", resourceId: "*" },
					payload: input,
					idempotencyKey: field(input, "idempotency_key"),
					handler: () =>
						options.management.controls.request({
							projectId: context.defaultProjectId,
							command: field(input, "command"),
							payload: (input.payload ?? {}) as never,
							...(input.session_id === undefined
								? {}
								: { sessionId: field(input, "session_id") }),
							...(input.generation_id === undefined
								? {}
								: { generationId: field(input, "generation_id") }),
							actor: context.actorId,
							idempotencyKey: field(input, "idempotency_key"),
						}),
				}),
			);
		},
		true,
	);
	register(
		"get",
		"/api/v1/management/control/:operation_id",
		(_request, reply, context) => {
			const params = _request.params as { operation_id: string };
			return sendResult(
				_request,
				reply,
				options.management.controls.get({
					projectId: context.defaultProjectId,
					id: params.operation_id,
				}),
			);
		},
	);
	register("get", "/api/v1/management/control", (_request, reply, context) => {
		return sendResult(
			_request,
			reply,
			options.management.controls.list(context.defaultProjectId),
		);
	});
	register("get", "/api/v1/management/audit", (_request, reply, context) => {
		return sendResult(
			_request,
			reply,
			options.management.audit(context.defaultProjectId),
		);
	});
	register(
		"post",
		"/api/v1/management/assets",
		(request, reply, context) => {
			const input = body(request);
			const encoded = field(input, "content_base64");
			if (encoded.length > 14_000_000)
				throw new TrackerManagementError(
					"management.asset_invalid",
					"asset content is too large",
				);
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(Buffer.from(encoded, "base64"));
			} catch {
				throw new TrackerManagementError(
					"management.asset_invalid",
					"asset content is not valid base64",
				);
			}
			return sendResult(
				request,
				reply.code(201),
				publicAsset(
					managementRoute({
						request,
						reply,
						context,
						commandKind: "management.asset.put",
						scope: { resourceType: "asset", resourceId: field(input, "ticket_id") },
						payload: input,
						handler: () =>
							options.management.assets.put({
								projectId: context.defaultProjectId,
								ticketId: field(input, "ticket_id"),
								relativePath: field(input, "relative_path"),
								mimeType: field(input, "mime_type"),
								bytes,
								actor: context.actorId,
							}) as TrackerManagementAsset,
					}) as TrackerManagementAsset,
				),
			);
		},
		true,
	);
	register("get", "/api/v1/management/assets/:asset_id", (_request, reply, context) => {
		const params = _request.params as { asset_id: string };
		const value = options.management.assets.read({
			projectId: context.defaultProjectId,
			ticketId: field(_request.query as Record<string, unknown>, "ticket_id"),
			assetId: params.asset_id,
		});
		return sendResult(_request, reply, {
			asset: publicAsset(value.asset),
			content_base64: Buffer.from(value.bytes).toString("base64"),
		});
	});
}
