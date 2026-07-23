import type { TrackerManagementAsset } from "@golem/persistence";
import {
	type CommandGateway,
	TrackerManagementError,
	type TrackerManagementServices,
} from "@golem/tracker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
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
				if (!authorized(request, reply, options.principal)) return;
				try {
					return await handler(request, reply);
				} catch (error) {
					managementFailure(request, reply, error);
				}
			},
		);
	};

	register("get", "/api/v1/management/roles", (request, reply) => {
		const query = request.query as Record<string, unknown>;
		return sendResult(
			request,
			reply,
			options.management.roles.list(field(query, "project_id")),
		);
	});
	register(
		"post",
		"/api/v1/management/roles",
		(request, reply) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				options.management.roles.create({
					projectId: field(input, "project_id"),
					name: field(input, "name"),
					scope: input.scope as never,
					definition: (input.definition ?? {}) as never,
					actor: field(input, "actor"),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/roles/:role_id/assign",
		(request, reply) => {
			const input = body(request);
			const params = request.params as { role_id: string };
			return sendResult(
				request,
				reply,
				options.management.roles.assign({
					projectId: field(input, "project_id"),
					roleId: params.role_id,
					...(input.session_id === undefined
						? {}
						: { sessionId: field(input, "session_id") }),
					...(input.generation_id === undefined
						? {}
						: { generationId: field(input, "generation_id") }),
					actor: field(input, "actor"),
					idempotencyKey: field(input, "idempotency_key"),
				}),
			);
		},
		true,
	);

	register("get", "/api/v1/management/gates", (request, reply) => {
		const query = request.query as Record<string, unknown>;
		return sendResult(
			request,
			reply,
			options.management.gates.list(field(query, "project_id")),
		);
	});
	register(
		"post",
		"/api/v1/management/gates",
		(request, reply) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				options.management.gates.create({
					projectId: field(input, "project_id"),
					kind: input.kind as never,
					question: field(input, "question"),
					assignee: field(input, "assignee"),
					idempotencyKey: field(input, "idempotency_key"),
					actor: field(input, "actor"),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/gates/:gate_id/verdict",
		(request, reply) => {
			const input = body(request);
			const params = request.params as { gate_id: string };
			return sendResult(
				request,
				reply,
				options.management.gates.answer({
					projectId: field(input, "project_id"),
					gateId: params.gate_id,
					status: input.status as never,
					verdict: (input.verdict ?? {}) as never,
					actor: field(input, "actor"),
				}),
			);
		},
		true,
	);

	register("get", "/api/v1/management/ideas", (request, reply) => {
		const query = request.query as Record<string, unknown>;
		return sendResult(
			request,
			reply,
			options.management.ideas.list(field(query, "project_id")),
		);
	});
	register(
		"post",
		"/api/v1/management/ideas",
		(request, reply) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				options.management.ideas.create({
					projectId: field(input, "project_id"),
					body: field(input, "body"),
					idempotencyKey: field(input, "idempotency_key"),
					actor: field(input, "actor"),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/ideas/:idea_id/pop",
		(request, reply) => {
			const input = body(request);
			const params = request.params as { idea_id: string };
			return sendResult(
				request,
				reply,
				options.management.ideas.pop({
					projectId: field(input, "project_id"),
					ideaId: params.idea_id,
					actor: field(input, "actor"),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/ideas/:idea_id/promote",
		(request, reply) => {
			const input = body(request);
			const params = request.params as { idea_id: string };
			return sendResult(
				request,
				reply,
				options.management.ideas.promote({
					projectId: field(input, "project_id"),
					ideaId: params.idea_id,
					actor: field(input, "actor"),
					...(input.title === undefined
						? {}
						: { title: field(input, "title") }),
				}),
			);
		},
		true,
	);

	register(
		"post",
		"/api/v1/management/communications",
		(request, reply) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				options.management.communications.create({
					projectId: field(input, "project_id"),
					kind: input.kind as never,
					command: field(input, "command"),
					payload: (input.payload ?? {}) as never,
					...(input.session_id === undefined
						? {}
						: { sessionId: field(input, "session_id") }),
					...(input.generation_id === undefined
						? {}
						: { generationId: field(input, "generation_id") }),
					actor: field(input, "actor"),
					idempotencyKey: field(input, "idempotency_key"),
				}),
			);
		},
		true,
	);
	register(
		"post",
		"/api/v1/management/control",
		(request, reply) => {
			const input = body(request);
			return sendResult(
				request,
				reply.code(201),
				options.management.controls.request({
					projectId: field(input, "project_id"),
					command: field(input, "command"),
					payload: (input.payload ?? {}) as never,
					...(input.session_id === undefined
						? {}
						: { sessionId: field(input, "session_id") }),
					...(input.generation_id === undefined
						? {}
						: { generationId: field(input, "generation_id") }),
					actor: field(input, "actor"),
					idempotencyKey: field(input, "idempotency_key"),
				}),
			);
		},
		true,
	);
	register(
		"get",
		"/api/v1/management/control/:operation_id",
		(request, reply) => {
			const query = request.query as Record<string, unknown>;
			const params = request.params as { operation_id: string };
			return sendResult(
				request,
				reply,
				options.management.controls.get({
					projectId: field(query, "project_id"),
					id: params.operation_id,
				}),
			);
		},
	);
	register("get", "/api/v1/management/control", (request, reply) => {
		const query = request.query as Record<string, unknown>;
		return sendResult(
			request,
			reply,
			options.management.controls.list(field(query, "project_id")),
		);
	});
	register("get", "/api/v1/management/audit", (request, reply) => {
		const query = request.query as Record<string, unknown>;
		return sendResult(
			request,
			reply,
			options.management.audit(field(query, "project_id")),
		);
	});
	register(
		"post",
		"/api/v1/management/assets",
		(request, reply) => {
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
					options.management.assets.put({
						projectId: field(input, "project_id"),
						ticketId: field(input, "ticket_id"),
						relativePath: field(input, "relative_path"),
						mimeType: field(input, "mime_type"),
						bytes,
						actor: field(input, "actor"),
					}),
				),
			);
		},
		true,
	);
	register("get", "/api/v1/management/assets/:asset_id", (request, reply) => {
		const query = request.query as Record<string, unknown>;
		const params = request.params as { asset_id: string };
		const value = options.management.assets.read({
			projectId: field(query, "project_id"),
			ticketId: field(query, "ticket_id"),
			assetId: params.asset_id,
		});
		return sendResult(request, reply, {
			asset: publicAsset(value.asset),
			content_base64: Buffer.from(value.bytes).toString("base64"),
		});
	});
}
