import crypto from "node:crypto";

import {
	type CommandGateway,
	CommandGatewayError as GatewayError,
	type CommandGatewayInput,
	type CommandGatewayOutcome,
	TrackerCoreError,
	type TrackerCoreServices,
	type TrackerServices,
} from "@golem/tracker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
	type ActorContext,
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
} from "./auth.js";
import { fail } from "./errors.js";

type JsonRecord = Record<string, unknown>;
type Caller = Readonly<{
	projectId: string;
	actor: string;
	principal: ActorContext;
}>;

function record(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function value(request: FastifyRequest): JsonRecord {
	return record(request.body);
}

function rejectForgedIdentity(input: JsonRecord): string | undefined {
	return Object.keys(input).some((key) =>
		/^(?:actor|created_?by|role|project(?:_?id)?|session(?:_?id)?|bearer|authorization|owner(?:_?fence|_?id)?|fence|approval|storage|principal|scope|sender_?id|worker_?id)$/iu.test(
			key,
		),
	)
		? "request authority is server-owned"
		: undefined;
}

function command(
	result: unknown,
	status: "completed" | "accepted" | "conflict" = "completed",
) {
	return {
		schema_version: "golem.api-command-outcome/v1",
		command_id: `cmd_${crypto.randomUUID()}`,
		status,
		result,
	};
}

function page(items: readonly unknown[], total = items.length) {
	return {
		schema_version: "golem.api-page/v1",
		items,
		next_cursor: null,
		total,
	};
}

function statusFor(error: unknown): number {
	const code = (error as Partial<TrackerCoreError>)?.code;
	if (code === "tracker.not_found") return 404;
	if (code === "tracker.conflict") return 409;
	if (code === "tracker.phase.invalid") return 409;
	if (
		error instanceof Error &&
		(error.name === "EnvelopeConflictError" ||
			error.name === "BusEventConflictError")
	)
		return 409;
	if (error instanceof Error && error.name === "CommandGatewayError") {
		const gatewayError = error as GatewayError;
		return gatewayError.httpStatus;
	}
	return 400;
}

function errorCode(error: unknown): string {
	const code = (error as Partial<TrackerCoreError>)?.code;
	if (typeof code === "string") return code;
	if (error instanceof Error && error.name === "CommandGatewayError") {
		const gatewayError = error as GatewayError;
		return gatewayError.status;
	}
	return "api.request.invalid";
}

function publicError(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
) {
	const raw = error instanceof Error ? error.message : "request rejected";
	const message = raw.includes("caller.identity")
		? raw
		: "typed API request was rejected";
	const code =
		error instanceof Error && error.name === "EnvelopeConflictError"
			? "delivery.conflict"
			: error instanceof Error && error.name === "BusEventConflictError"
				? "bus.conflict"
				: raw.includes("not eligible")
					? "delivery.ineligible"
					: errorCode(error);
	return fail(request, reply, statusFor(error), code, message);
}

function normalizeQuery(request: FastifyRequest): JsonRecord {
	return record(request.query);
}

/**
 * Typed mutations are compare-and-swap commands.  A missing or malformed
 * precondition is rejected at the HTTP boundary instead of silently falling
 * back to the current revision (which would turn an omitted CAS into an
 * unconditional write).
 */
function expectedRevision(
	input: JsonRecord,
	request: FastifyRequest,
	reply: FastifyReply,
): number | undefined {
	const candidate = input.expected_revision;
	if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
		fail(
			request,
			reply,
			400,
			"tracker.revision.required",
			"expected_revision must be a positive safe integer",
		);
		return undefined;
	}
	return candidate as number;
}

type ClaimRecord = ReturnType<TrackerServices["delivery"]["claim"]>[number];

/**
 * Authenticated typed API plugins.  They receive only composed tracker
 * capabilities; no route obtains a SQLite handle, runtime endpoint authority,
 * or native transport.  Legacy names are registered separately as delegates.
 */
export function registerApiV1Routes(options: {
	readonly app: FastifyInstance;
	readonly principal: BrowserPrincipalResolver;
	readonly core: TrackerCoreServices;
	readonly services: TrackerServices;
	readonly gateway?: CommandGateway;
}): void {
	const claims = new Map<string, ClaimRecord>();
	const subscriptions = new Map<
		string,
		ReturnType<TrackerServices["subscriptions"]["subscribe"]>
	>();
	const busEvents: unknown[] = [];
	const gateway = options.gateway;
	const guard = (
		request: FastifyRequest,
		reply: FastifyReply,
	): Caller | undefined => {
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
		const context = options.principal.resolve(request, {
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
		if (!options.principal.policy.allows(context, action)) {
			fail(
				request,
				reply,
				403,
				"browser.forbidden",
				"the authenticated principal is not authorized",
			);
			return undefined;
		}
		return Object.freeze({
			projectId: context.defaultProjectId,
			actor: context.actorId,
			principal: context,
		});
	};
	const withIdentity = (
		request: FastifyRequest,
		reply: FastifyReply,
		_callerValue: Caller,
	): JsonRecord | undefined => {
		const input = value(request);
		const forged = rejectForgedIdentity(input);
		if (forged) {
			fail(request, reply, 403, "caller.identity.spoofed", forged);
			return undefined;
		}
		return input;
	};
	/**
	 * A ticket path parameter is never authority. Resolve it through the
	 * canonical compatibility facade and deliberately collapse a foreign target
	 * into the same result as an absent one before a command can run.
	 */
	const ticketInCallerScope = (callerValue: Caller, id: string): boolean => {
		const ticket = options.core.compatibility.getTicket(id);
		return (
			ticket !== undefined &&
			typeof ticket.project_id === "string" &&
			options.principal.policy.allowsProject(
				callerValue.principal,
				ticket.project_id,
			)
		);
	};
	const ticketNotFound = (request: FastifyRequest, reply: FastifyReply) =>
		fail(request, reply, 404, "tracker.not_found", "ticket was not found");

	/**
	 * Route a typed command through the durable command gateway when one is
	 * composed.  When no gateway is present (legacy journey fixtures), fall
	 * back to the direct service call.  Returns `undefined` if the gateway
	 * outcome was already sent (mismatch/conflict); otherwise returns the
	 * typed outcome for the caller to send.
	 */
	function gatewayRoute(input: {
		readonly request: FastifyRequest;
		readonly reply: FastifyReply;
		readonly caller: Caller;
		readonly commandKind: string;
		readonly scope: CommandGatewayInput["scope"];
		readonly payload: Readonly<Record<string, unknown>>;
		readonly idempotencyKey: string | undefined;
		readonly expectedRevision?: number;
		readonly handler: () => unknown;
	}): CommandGatewayOutcome | undefined {
		if (!gateway) return undefined;
		const idempotencyKey =
			typeof input.idempotencyKey === "string" && input.idempotencyKey
				? input.idempotencyKey
				: `auto:${input.commandKind}:${crypto.randomUUID()}`;
		const outcome = gateway.execute({
			commandId: `cmd_${crypto.randomUUID()}`,
			idempotencyKey,
			commandKind: input.commandKind,
			actorId: input.caller.actor,
			projectId: input.caller.projectId,
			correlationId: `cor_${crypto.randomUUID()}`,
			scope: input.scope,
			...(input.expectedRevision !== undefined
				? { expectedRevision: input.expectedRevision }
				: {}),
			payload: input.payload,
			handler: input.handler,
		});
		return outcome;
	}

	function sendGatewayOutcome(
		reply: FastifyReply,
		outcome: CommandGatewayOutcome,
		created = false,
	): void {
		if (outcome.status === "idempotency_mismatch") {
			reply.code(409);
			reply.send({
				schema_version: "golem.api-error/v1",
				code: "command.idempotency_mismatch",
				message: "idempotency key reused with a differing payload",
				correlation_id: outcome.command_id,
			});
			return;
		}
		reply.code(created && outcome.status === "completed" ? 201 : 200);
		reply.send(outcome);
	}

	options.app.get("/api/v1/tracker/tickets", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		try {
			const query = normalizeQuery(request);
			const items = options.core.compatibility.listTickets({
				projectId: callerValue.projectId,
				...(typeof query.kind === "string"
					? { kind: query.kind as never }
					: {}),
				...(typeof query.phase === "string" ? { phase: query.phase } : {}),
				...(typeof query.assignee === "string"
					? { assignee: query.assignee }
					: {}),
			});
			return reply.send(page(items));
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.get("/api/v1/tracker/tickets/search", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		try {
			const query = normalizeQuery(request);
			return reply.send(
				page(
					options.core.compatibility.searchTickets(
						typeof query.q === "string" ? query.q : "",
						callerValue.projectId,
					),
				),
			);
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.get("/api/v1/tracker/tickets/:id", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		try {
			const id = (request.params as { id: string }).id;
			const ticket = options.core.compatibility.getTicket(id);
			if (!ticket || ticket.project_id !== callerValue.projectId)
				return fail(
					request,
					reply,
					404,
					"tracker.not_found",
					"ticket was not found",
				);
			return reply.send(ticket);
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.post("/api/v1/tracker/tickets", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			if (gateway) {
				const idempotencyKey =
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: `auto:ticket.create:${crypto.randomUUID()}`;
				const outcome = gateway.execute({
					commandId: `cmd_${crypto.randomUUID()}`,
					idempotencyKey,
					commandKind: "ticket.create",
					actorId: callerValue.actor,
					projectId: callerValue.projectId,
					correlationId: `correlation_${crypto.randomUUID()}`,
					scope: { resourceType: "ticket", resourceId: "new" },
					payload: input,
					handler: () =>
						options.core.compatibility.createTicket({
							projectId: callerValue.projectId,
							kind: input.kind as never,
							title: input.title as string,
							...(typeof input.body === "string"
								? { body: input.body }
								: {}),
							...(typeof input.priority === "string"
								? { priority: input.priority as never }
								: {}),
							...(Array.isArray(input.labels)
								? { labels: input.labels as readonly string[] }
								: {}),
							...(typeof input.stream_id === "string"
								? { streamId: input.stream_id }
								: {}),
							...(typeof input.parent_id === "string"
								? { parentId: input.parent_id }
								: {}),
							...(typeof input.assignee === "string"
								? { assignee: input.assignee }
								: {}),
							...(typeof input.rank === "number"
								? { rank: input.rank }
								: {}),
							...(typeof input.wave === "number"
								? { wave: input.wave }
								: {}),
						actor: callerValue.actor,
					}),
			});
			if (outcome) return sendGatewayOutcome(reply, outcome, true);
		}
			const result = command(
				options.core.compatibility.createTicket({
					projectId: callerValue.projectId,
					kind: input.kind as never,
					title: input.title as string,
					...(typeof input.body === "string" ? { body: input.body } : {}),
					...(typeof input.priority === "string"
						? { priority: input.priority as never }
						: {}),
					...(Array.isArray(input.labels)
						? { labels: input.labels as readonly string[] }
						: {}),
					...(typeof input.stream_id === "string"
						? { streamId: input.stream_id }
						: {}),
					...(typeof input.parent_id === "string"
						? { parentId: input.parent_id }
						: {}),
					...(typeof input.assignee === "string"
						? { assignee: input.assignee }
						: {}),
					...(typeof input.rank === "number" ? { rank: input.rank } : {}),
					...(typeof input.wave === "number" ? { wave: input.wave } : {}),
					actor: callerValue.actor,
				}),
			);
			return reply.code(201).send(result);
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.patch("/api/v1/tracker/tickets/:id", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			const id = (request.params as { id: string }).id;
			const current = options.core.compatibility.getTicket(id);
			if (!current || current.project_id !== callerValue.projectId)
				return fail(
					request,
					reply,
					404,
					"tracker.not_found",
					"ticket was not found",
				);
			const revision = expectedRevision(input, request, reply);
			if (revision === undefined) return;
			if (gateway) {
				const outcome = gatewayRoute({
					request,
					reply,
					caller: callerValue,
					commandKind: "ticket.update",
					scope: { resourceType: "ticket", resourceId: id },
					payload: input,
					idempotencyKey:
						typeof input.idempotency_key === "string"
							? input.idempotency_key
							: undefined,
					expectedRevision: revision,
					handler: () =>
						options.core.compatibility.updateTicket({
							id,
							expectedRevision: revision,
							patch: {
								...(typeof input.title === "string"
									? { title: input.title }
									: {}),
								...(typeof input.body === "string"
									? { body: input.body }
									: {}),
								...(typeof input.priority === "string"
									? { priority: input.priority as never }
									: {}),
								...(Array.isArray(input.labels)
									? { labels: input.labels as readonly string[] }
									: {}),
								...(typeof input.assignee === "string"
									? { assignee: input.assignee }
									: {}),
								...(typeof input.rank === "number"
									? { rank: input.rank }
									: {}),
								...(typeof input.wave === "number"
									? { wave: input.wave }
									: {}),
							},
							...(typeof input.reason === "string"
								? { reason: input.reason }
								: {}),
					actor: callerValue.actor,
				}),
			});
			if (outcome) return sendGatewayOutcome(reply, outcome);
		}
		const result = command(
			options.core.compatibility.updateTicket({
				id,
				expectedRevision: revision,
					patch: {
						...(typeof input.title === "string" ? { title: input.title } : {}),
						...(typeof input.body === "string" ? { body: input.body } : {}),
						...(typeof input.priority === "string"
							? { priority: input.priority as never }
							: {}),
						...(Array.isArray(input.labels)
							? { labels: input.labels as readonly string[] }
							: {}),
						...(typeof input.assignee === "string"
							? { assignee: input.assignee }
							: {}),
						...(typeof input.rank === "number" ? { rank: input.rank } : {}),
						...(typeof input.wave === "number" ? { wave: input.wave } : {}),
					},
					...(typeof input.reason === "string" ? { reason: input.reason } : {}),
					actor: callerValue.actor,
				}),
			);
			return reply.send(result);
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.post(
		"/api/v1/tracker/tickets/:id/transition",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			try {
				const id = (request.params as { id: string }).id;
				const current = options.core.compatibility.getTicket(id);
				if (!current || current.project_id !== callerValue.projectId)
					return fail(
						request,
						reply,
						404,
						"tracker.not_found",
						"ticket was not found",
					);
			const revision = expectedRevision(input, request, reply);
			if (revision === undefined) return;
			if (gateway) {
				const outcome = gatewayRoute({
					request,
					reply,
					caller: callerValue,
					commandKind: "ticket.transition",
					scope: { resourceType: "ticket", resourceId: id },
					payload: input,
					idempotencyKey:
						typeof input.idempotency_key === "string"
							? input.idempotency_key
							: undefined,
					expectedRevision: revision,
					handler: () =>
						options.core.compatibility.transitionTicket({
							id,
							expectedRevision: revision,
							phase: input.phase as string,
							...(typeof input.reason === "string"
								? { reason: input.reason }
								: {}),
						actor: callerValue.actor,
					}),
			});
			if (outcome) return sendGatewayOutcome(reply, outcome);
		}
		return reply.send(
			command(
				options.core.compatibility.transitionTicket({
					id,
					expectedRevision: revision,
					phase: input.phase as string,
					...(typeof input.reason === "string"
						? { reason: input.reason }
						: {}),
					actor: callerValue.actor,
				}),
			),
		);
		} catch (error) {
			return publicError(request, reply, error);
		}
	},
);

	options.app.post(
		"/api/v1/tracker/tickets/:id/close",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			const keys = Object.keys(input);
			if (keys.some((key) => !["expected_revision", "reason"].includes(key)))
				return fail(
					request,
					reply,
					403,
					"tracker.close.authority",
					"exceptional close authority is server-owned",
				);
			return fail(
				request,
				reply,
				403,
				"tracker.close.authority",
				"exceptional close requires a verified authority composition",
			);
		},
	);

	options.app.post(
		"/api/v1/tracker/tickets/:id/comments",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			try {
				const id = (request.params as { id: string }).id;
				if (!ticketInCallerScope(callerValue, id))
					return ticketNotFound(request, reply);
				const suppliedAnchor = record(input.anchor);
				const anchor =
					Object.keys(suppliedAnchor).length > 0
						? suppliedAnchor
						: Object.fromEntries(
								[
									["quote", input.quote],
									["prefix", input.prefix],
									["suffix", input.suffix],
									["section", input.section],
									["sectionId", input.section_id],
								].filter(([, candidate]) => typeof candidate === "string"),
							);
				const commentPayload = {
					ticket_id: id,
					body: input.body as string,
					...(Object.keys(anchor).length > 0 ? { anchor } : {}),
					...(typeof input.tag === "string" ? { tag: input.tag } : {}),
					...(typeof input.status === "string"
						? { status: input.status }
						: {}),
				};
				if (gateway) {
					const outcome = gatewayRoute({
						request,
						reply,
						caller: callerValue,
						commandKind: "ticket.comment.create",
						scope: { resourceType: "comment", resourceId: id },
						payload: commentPayload,
						idempotencyKey:
							typeof input.idempotency_key === "string"
								? input.idempotency_key
								: undefined,
						handler: () =>
							options.core.compatibility.addComment({
								ticketId: id,
								author: callerValue.actor,
								body: input.body as string,
								...(Object.keys(anchor).length > 0 ? { anchor } : {}),
								...(typeof input.tag === "string"
									? { tag: input.tag }
									: {}),
								...(typeof input.status === "string"
									? { status: input.status }
									: {}),
							}),
					});
					if (outcome) return sendGatewayOutcome(reply, outcome, true);
				}
				return reply.code(201).send(
					command(
						options.core.compatibility.addComment({
							ticketId: id,
							author: callerValue.actor,
							body: input.body as string,
							...(Object.keys(anchor).length > 0 ? { anchor } : {}),
							...(typeof input.tag === "string" ? { tag: input.tag } : {}),
							...(typeof input.status === "string"
								? { status: input.status }
								: {}),
						}),
					),
				);
			} catch (error) {
				return publicError(request, reply, error);
			}
		},
	);

	options.app.post(
		"/api/v1/tracker/tickets/:id/comments/:commentId/reply",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			try {
				const params = request.params as { id: string; commentId: string };
				if (!ticketInCallerScope(callerValue, params.id))
					return ticketNotFound(request, reply);
				const replyPayload = {
					ticket_id: params.id,
					parent_id: params.commentId,
					body: input.body as string,
				};
				if (gateway) {
					const outcome = gatewayRoute({
						request,
						reply,
						caller: callerValue,
						commandKind: "ticket.comment.reply",
						scope: {
							resourceType: "comment",
							resourceId: params.commentId,
						},
						payload: replyPayload,
						idempotencyKey:
							typeof input.idempotency_key === "string"
								? input.idempotency_key
								: undefined,
						handler: () =>
							options.core.compatibility.replyComment({
								ticketId: params.id,
								parentId: params.commentId,
								author: callerValue.actor,
								body: input.body as string,
							}),
					});
					if (outcome) return sendGatewayOutcome(reply, outcome, true);
				}
				return reply.code(201).send(
					command(
						options.core.compatibility.replyComment({
							ticketId: params.id,
							parentId: params.commentId,
							author: callerValue.actor,
							body: input.body as string,
						}),
					),
				);
			} catch (error) {
				return publicError(request, reply, error);
			}
		},
	);

	options.app.patch(
		"/api/v1/tracker/tickets/:id/comments/:commentId",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			try {
				const params = request.params as { id: string; commentId: string };
				if (!ticketInCallerScope(callerValue, params.id))
					return ticketNotFound(request, reply);
				const updatePayload = {
					ticket_id: params.id,
					comment_id: params.commentId,
					...(typeof input.body === "string" ? { body: input.body } : {}),
					...(typeof input.tag === "string" ? { tag: input.tag } : {}),
					...(typeof input.status === "string"
						? { status: input.status }
						: {}),
				};
				if (gateway) {
					const outcome = gatewayRoute({
						request,
						reply,
						caller: callerValue,
						commandKind: "ticket.comment.update",
						scope: {
							resourceType: "comment",
							resourceId: params.commentId,
						},
						payload: updatePayload,
						idempotencyKey:
							typeof input.idempotency_key === "string"
								? input.idempotency_key
								: undefined,
						handler: () =>
							options.core.compatibility.updateComment({
								ticketId: params.id,
								commentId: params.commentId,
								patch: {
									...(typeof input.body === "string"
										? { body: input.body }
										: {}),
									...(typeof input.tag === "string"
										? { tag: input.tag }
										: {}),
									...(typeof input.status === "string"
										? { status: input.status }
										: {}),
								},
								actor: callerValue.actor,
							}),
					});
					if (outcome) return sendGatewayOutcome(reply, outcome);
				}
				return reply.send(
					command(
						options.core.compatibility.updateComment({
							ticketId: params.id,
							commentId: params.commentId,
							patch: {
								...(typeof input.body === "string" ? { body: input.body } : {}),
								...(typeof input.tag === "string" ? { tag: input.tag } : {}),
								...(typeof input.status === "string"
									? { status: input.status }
									: {}),
							},
							actor: callerValue.actor,
						}),
					),
				);
			} catch (error) {
				return publicError(request, reply, error);
			}
		},
	);

	options.app.post("/api/v1/tracker/streams", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			const streamId =
				typeof input.id === "string" ? input.id : `stream_${crypto.randomUUID()}`;
			const streamPayload = {
				id: streamId,
				name: input.name as string,
				...(input.mode === "sequential" || input.mode === "parallel"
					? { mode: input.mode }
					: {}),
				...(typeof input.description === "string"
					? { description: input.description }
					: {}),
				...(typeof input.expected_revision === "number"
					? { expected_revision: input.expected_revision }
					: {}),
			};
			if (gateway) {
				const outcome = gatewayRoute({
					request,
					reply,
					caller: callerValue,
					commandKind: "stream.upsert",
					scope: { resourceType: "stream", resourceId: streamId },
					payload: streamPayload,
					idempotencyKey:
						typeof input.idempotency_key === "string"
							? input.idempotency_key
							: undefined,
					...(typeof input.expected_revision === "number"
						? { expectedRevision: input.expected_revision }
						: {}),
					handler: () =>
						options.core.compatibility.upsertStream({
							...(typeof input.id === "string" ? { id: input.id } : {}),
							projectId: callerValue.projectId,
							name: input.name as string,
							...(input.mode === "sequential" || input.mode === "parallel"
								? { mode: input.mode }
								: {}),
							...(typeof input.description === "string"
								? { description: input.description }
								: {}),
							...(typeof input.expected_revision === "number"
								? { expectedRevision: input.expected_revision }
								: {}),
							actor: callerValue.actor,
						}),
				});
				if (outcome) return sendGatewayOutcome(reply, outcome, true);
			}
			return reply.code(201).send(
				command(
					options.core.compatibility.upsertStream({
						...(typeof input.id === "string" ? { id: input.id } : {}),
						projectId: callerValue.projectId,
						name: input.name as string,
						...(input.mode === "sequential" || input.mode === "parallel"
							? { mode: input.mode }
							: {}),
						...(typeof input.description === "string"
							? { description: input.description }
							: {}),
						...(typeof input.expected_revision === "number"
							? { expectedRevision: input.expected_revision }
							: {}),
						actor: callerValue.actor,
					}),
				),
			);
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.get("/api/v1/tracker/streams", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		return reply.send(
			page(options.core.compatibility.listStreams(callerValue.projectId)),
		);
	});

	options.app.post("/api/v1/delivery/envelopes", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			if (
				typeof input.sender_id === "string" &&
				input.sender_id !== callerValue.actor
			)
				return fail(
					request,
					reply,
					403,
					"caller.identity.spoofed",
					"sender identity is process-composed",
				);
			const envelope = options.services.delivery.enqueue({
				id: input.id as string,
				projectId: callerValue.projectId,
				idempotencyKey: input.idempotency_key as string,
				senderId: callerValue.actor,
				recipientId: input.recipient_id as string,
				kind: input.kind as string,
				payload: record(input.payload),
				...(typeof input.deadline_at === "string"
					? { deadlineAt: input.deadline_at }
					: {}),
				...(typeof input.max_attempts === "number"
					? { maxAttempts: input.max_attempts }
					: {}),
			});
			return reply.code(201).send(command(envelope));
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.post("/api/v1/delivery/claims", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			if (
				typeof input.worker_id === "string" &&
				input.worker_id !== callerValue.actor
			)
				return fail(
					request,
					reply,
					403,
					"caller.identity.spoofed",
					"worker identity is process-composed",
				);
			const result = options.services.delivery.claim(
				callerValue.actor,
				typeof input.limit === "number" ? input.limit : 10,
				typeof input.lease_ms === "number" ? input.lease_ms : undefined,
			);
			const items = result.map((claim) => {
				claims.set(claim.envelope.claimToken, claim);
				return claim.envelope;
			});
			return reply.send(page(items));
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.post(
		"/api/v1/delivery/claims/:token/prepare",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const token = (request.params as { token: string }).token;
			const claim = claims.get(token);
			if (!claim)
				return fail(
					request,
					reply,
					404,
					"delivery.claim.not_found",
					"delivery claim is not available",
				);
			const prepared = claim.prepare();
			if (prepared.kind === "stale")
				return reply.code(409).send(command(prepared, "conflict"));
			return reply.send(command(prepared));
		},
	);

	options.app.post(
		"/api/v1/delivery/claims/:token/ack",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const token = (request.params as { token: string }).token;
			const claim = claims.get(token);
			if (!claim)
				return fail(
					request,
					reply,
					404,
					"delivery.claim.not_found",
					"delivery claim is not available",
				);
			try {
				const input = value(request);
				return reply.send(
					command({
						accepted: claim.acknowledge(
							input.acknowledgement_id as string,
							record(input.payload),
						),
					}),
				);
			} catch (error) {
				return publicError(request, reply, error);
			}
		},
	);

	for (const action of ["delivered", "fail"] as const) {
		options.app.post(
			`/api/v1/delivery/claims/:token/${action}`,
			async (request, reply) => {
				const callerValue = guard(request, reply);
				if (!callerValue) return;
				const token = (request.params as { token: string }).token;
				const claim = claims.get(token);
				if (!claim)
					return fail(
						request,
						reply,
						404,
						"delivery.claim.not_found",
						"delivery claim is not available",
					);
				try {
					const result =
						action === "delivered"
							? claim.delivered()
							: claim.fail(
									typeof value(request).error === "string"
										? (value(request).error as string)
										: "delivery failed",
								);
					claims.delete(token);
					return reply.send(command(result));
				} catch (error) {
					return publicError(request, reply, error);
				}
			},
		);
	}

	options.app.post("/api/v1/bus/events", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			const event = options.services.bus.append({
				id: input.id as string,
				projectId: callerValue.projectId,
				deduplicationKey: input.deduplication_key as string,
				topic: input.topic as string,
				class: input.class as never,
				payload: record(input.payload),
			});
			busEvents.push(event);
			return reply.code(201).send(command(event));
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.get("/api/v1/bus/events", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		return reply.send(page(busEvents));
	});

	options.app.post("/api/v1/subscriptions", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const input = withIdentity(request, reply, callerValue);
		if (!input) return;
		try {
			const subscription = options.services.subscriptions.subscribe({
				...(typeof input.id === "string" ? { id: input.id } : {}),
				name:
					(input.name as string) ||
					`mcp:${callerValue.actor}:${input.topic as string}`,
				recipientId: callerValue.actor,
				topic: input.topic as string,
				...(Array.isArray(input.classes)
					? { classes: input.classes as never }
					: {}),
				...(typeof input.cursor === "number" ? { cursor: input.cursor } : {}),
			});
			subscriptions.set(subscription.id, subscription);
			return reply.code(201).send(command(subscription));
		} catch (error) {
			return publicError(request, reply, error);
		}
	});

	options.app.get("/api/v1/subscriptions", async (request, reply) => {
		const callerValue = guard(request, reply);
		if (!callerValue) return;
		const recipientId = callerValue.actor;
		return reply.send(
			page(
				[...subscriptions.values()].filter(
					(subscription) => subscription.recipientId === recipientId,
				),
			),
		);
	});

	options.app.post(
		"/api/v1/subscriptions/unsubscribe",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			const recipientId = callerValue.actor;
			const subscription = [...subscriptions.values()].find(
				(candidate) =>
					candidate.recipientId === recipientId &&
					candidate.topic === input.topic,
			);
			if (!subscription) return reply.send(command({ removed: 0 }));
			const suspended = options.services.subscriptions.subscribe({
				id: subscription.id,
				name: subscription.name,
				recipientId: subscription.recipientId,
				topic: subscription.topic,
				classes: subscription.classes,
				cursor: subscription.cursor,
				manual: subscription.manual,
				status: "suspended",
			});
			subscriptions.set(suspended.id, suspended);
			return reply.send(command({ removed: 1 }));
		},
	);

	options.app.get(
		"/api/v1/subscriptions/:id/pending",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			try {
				const pending = options.services.subscriptions.pending(
					(request.params as { id: string }).id,
				);
				if (!pending)
					return fail(
						request,
						reply,
						404,
						"subscription.not_found",
						"subscription was not found",
					);
				return reply.send(pending);
			} catch (error) {
				return publicError(request, reply, error);
			}
		},
	);

	options.app.post(
		"/api/v1/subscriptions/:id/commit",
		async (request, reply) => {
			const callerValue = guard(request, reply);
			if (!callerValue) return;
			const input = withIdentity(request, reply, callerValue);
			if (!input) return;
			try {
				return reply.send(
					command({
						committed: options.services.subscriptions.commit(
							(request.params as { id: string }).id,
							Number(input.from_sequence),
							Number(input.to_sequence),
						),
					}),
				);
			} catch (error) {
				return publicError(request, reply, error);
			}
		},
	);
}
