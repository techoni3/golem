import crypto from "node:crypto";

import {
	type CommandGateway,
	type CommandGatewayInput,
	type TrackerCompatibilityFacade,
	TrackerCoreError,
} from "@golem/tracker";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
	type ActorContext,
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
} from "./auth.js";
import { fail as apiFail } from "./errors.js";

type LegacyBody = Readonly<Record<string, unknown>>;

function body(value: unknown): LegacyBody {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as LegacyBody)
		: {};
}

function expectedRevision(value: LegacyBody, fallback: number): number {
	const candidate = value.expected_revision ?? value.revision;
	return typeof candidate === "number" ? candidate : fallback;
}

function contextFor(
	options: {
		readonly principal: BrowserPrincipalResolver;
	},
	request: Parameters<BrowserPrincipalResolver["resolve"]>[0],
	action: "read" | "mutate",
): ActorContext {
	const context = options.principal.resolve(request, {
		action,
		allowBrowser: true,
		allowBearer: true,
	});
	if (!context)
		throw new TrackerCoreError(
			"tracker.not_found",
			"tracker resource was not found",
		);
	return context;
}

function scopedTicket(
	options: {
		readonly principal: BrowserPrincipalResolver;
		readonly tracker: TrackerCompatibilityFacade;
	},
	context: ActorContext,
	id: string,
) {
	const ticket = options.tracker.getTicket(id);
	return ticket &&
		typeof ticket.project_id === "string" &&
		options.principal.policy.allowsProject(context, ticket.project_id)
		? ticket
		: undefined;
}

function notFound(reply: FastifyReply): FastifyReply {
	return reply
		.code(404)
		.send({ error: "ticket not found", code: "tracker.not_found" });
}

function legacyPhaseForState(kind: string, state: unknown): string | undefined {
	if (
		state !== "todo" &&
		state !== "in_progress" &&
		state !== "blocked" &&
		state !== "review" &&
		state !== "done"
	)
		return undefined;
	if (kind === "spec")
		return {
			todo: "drafting",
			in_progress: "designing",
			blocked: "parked",
			review: "designed",
			done: "done",
		}[state];
	if (kind === "question")
		return {
			todo: "open",
			in_progress: "open",
			blocked: "open",
			review: "answered",
			done: "closed",
		}[state];
	if (kind === "decision")
		return {
			todo: "open",
			in_progress: "open",
			blocked: "open",
			review: "decided",
			done: "closed",
		}[state];
	return {
		todo: "queued",
		in_progress: "building",
		blocked: "blocked",
		review: "built",
		done: "done",
	}[state];
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
	if (error instanceof TrackerCoreError) {
		const status =
			error.code === "tracker.not_found"
				? 404
				: error.code === "tracker.conflict"
					? 409
					: 400;
		return reply.code(status).send({ error: error.message, code: error.code });
	}
	return reply
		.code(400)
		.send({ error: error instanceof Error ? error.message : String(error) });
}

/**
 * Thin C1–C3 compatibility adapter. It carries legacy REST names over the
 * typed facade; phase legality and transactional audit/outbox remain in the
 * tracker application/repository layers.
 */
export function registerTrackerCoreCompatibilityRoutes(options: {
	readonly app: FastifyInstance;
	readonly tracker: TrackerCompatibilityFacade;
	readonly principal: BrowserPrincipalResolver;
	readonly gateway?: CommandGateway;
}): void {
	const gateway = options.gateway;

	function gatewayRoute(input: {
		readonly context: ActorContext;
		readonly commandKind: string;
		readonly scope: CommandGatewayInput["scope"];
		readonly payload: Readonly<Record<string, unknown>>;
		readonly idempotencyKey: string | undefined;
		readonly expectedRevision?: number;
		readonly handler: () => unknown;
	}): unknown {
		if (!gateway) return undefined;
		const key =
			typeof input.idempotencyKey === "string" && input.idempotencyKey
				? input.idempotencyKey
				: `auto:legacy:${input.commandKind}:${crypto.randomUUID()}`;
		return gateway.execute({
			commandId: `cmd_${crypto.randomUUID()}`,
			idempotencyKey: key,
			commandKind: input.commandKind,
			actorId: input.context.actorId,
			projectId: input.context.defaultProjectId,
			correlationId: `cor_${crypto.randomUUID()}`,
			scope: input.scope,
			...(input.expectedRevision !== undefined
				? { expectedRevision: input.expectedRevision }
				: {}),
			payload: input.payload,
			handler: input.handler,
		});
	}

	options.app.addHook("preHandler", async (request, reply) => {
		if (
			!request.url.startsWith("/api/tickets") &&
			!request.url.startsWith("/api/streams")
		)
			return;
		if (hasRequestAuthorityOverride(request)) {
			return apiFail(
				request,
				reply,
				403,
				"browser.forbidden",
				"request authority is server-owned",
			);
		}
		const action = request.method === "GET" ? "read" : "mutate";
		const context = options.principal.resolve(request, {
			action,
			allowBrowser: true,
			allowBearer: true,
		});
		if (!context)
			return apiFail(
				request,
				reply,
				401,
				"browser.auth.required",
				"an authenticated principal binding is required",
			);
		if (!options.principal.policy.allows(context, action))
			return apiFail(
				request,
				reply,
				403,
				"browser.forbidden",
				"the authenticated principal is not authorized",
			);
	});
	options.app.get("/api/tickets", async (request) => {
		const context = contextFor(options, request, "read");
		const query = request.query as LegacyBody;
		return options.tracker.listTickets({
			projectId: context.defaultProjectId,
			...(typeof query.kind === "string" ? { kind: query.kind as never } : {}),
			...(typeof query.phase === "string" ? { phase: query.phase } : {}),
			...(typeof query.assignee === "string"
				? { assignee: query.assignee }
				: {}),
		});
	});
	options.app.get("/api/tickets/search", async (request, reply) => {
		try {
			const context = contextFor(options, request, "read");
			const query = request.query as LegacyBody;
			return options.tracker.searchTickets(
				typeof query.q === "string"
					? query.q
					: typeof query.query === "string"
						? query.query
						: "",
				context.defaultProjectId,
			);
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.get("/api/tickets/:id", async (request, reply) => {
		const context = contextFor(options, request, "read");
		return (
			scopedTicket(options, context, (request.params as { id: string }).id) ??
			notFound(reply)
		);
	});
	options.app.post("/api/tickets", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const handler = () =>
				options.tracker.createTicket({
					projectId: context.defaultProjectId,
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
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.ticket.create",
				scope: { resourceType: "ticket", resourceId: "*" },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.patch("/api/tickets/:id", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const id = (request.params as { id: string }).id;
			const input = body(request.body);
			const current = scopedTicket(options, context, id);
			if (!current) return notFound(reply);
			const revision = expectedRevision(input, Number(current.revision));
			if (input.phase !== undefined || input.state !== undefined) {
				const phase =
					typeof input.phase === "string"
						? input.phase
						: legacyPhaseForState(String(current.kind), input.state);
				if (!phase)
					return reply.code(400).send({
						error: "legacy state has no canonical phase",
						code: "tracker.phase.invalid",
					});
				const handler = () =>
					options.tracker.transitionTicket({
						id,
						expectedRevision: revision,
						phase,
						...(typeof input.reason === "string"
							? { reason: input.reason }
							: {}),
						actor: context.actorId,
					});
				const outcome = gatewayRoute({
					context,
					commandKind: "legacy.ticket.transition",
					scope: { resourceType: "ticket", resourceId: id },
					payload: input,
					idempotencyKey:
						typeof input.idempotency_key === "string"
							? input.idempotency_key
							: undefined,
					expectedRevision: revision,
					handler,
				});
				return outcome ?? handler();
			}
			const handler = () =>
				options.tracker.updateTicket({
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
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.ticket.update",
				scope: { resourceType: "ticket", resourceId: id },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				expectedRevision: revision,
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.post("/api/tickets/:id/transition", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const id = (request.params as { id: string }).id;
			const current = scopedTicket(options, context, id);
			if (!current) return notFound(reply);
			const revision = expectedRevision(input, Number(current.revision));
			const handler = () =>
				options.tracker.transitionTicket({
					id,
					expectedRevision: revision,
					phase: input.phase as string,
					...(typeof input.reason === "string" ? { reason: input.reason } : {}),
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.ticket.transition",
				scope: { resourceType: "ticket", resourceId: id },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				expectedRevision: revision,
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.post("/api/tickets/:id/comments", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const ticketId = (request.params as { id: string }).id;
			if (!scopedTicket(options, context, ticketId)) return notFound(reply);
			const anchor = input.anchor;
			const handler = () =>
				options.tracker.addComment({
					ticketId,
					author: context.actorId,
					body: input.body as string,
					...(anchor && typeof anchor === "object" && !Array.isArray(anchor)
						? { anchor: anchor as Record<string, unknown> }
						: {}),
					...(typeof input.tag === "string" ? { tag: input.tag } : {}),
					...(typeof input.status === "string" ? { status: input.status } : {}),
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.comment.create",
				scope: { resourceType: "comment", resourceId: ticketId },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.post(
		"/api/tickets/:id/comments/:commentId/reply",
		async (request, reply) => {
			try {
				const context = contextFor(options, request, "mutate");
				const input = body(request.body);
				const ticketId = (request.params as { id: string }).id;
				const commentId = (request.params as { commentId: string }).commentId;
				if (!scopedTicket(options, context, ticketId)) return notFound(reply);
				const handler = () =>
					options.tracker.replyComment({
						ticketId,
						parentId: commentId,
						author: context.actorId,
						body: input.body as string,
					});
				const outcome = gatewayRoute({
					context,
					commandKind: "legacy.comment.reply",
					scope: { resourceType: "comment", resourceId: commentId },
					payload: input,
					idempotencyKey:
						typeof input.idempotency_key === "string"
							? input.idempotency_key
							: undefined,
					handler,
				});
				return outcome ?? handler();
			} catch (error) {
				return fail(reply, error);
			}
		},
	);
	options.app.patch(
		"/api/tickets/:id/comments/:commentId",
		async (request, reply) => {
			try {
				const context = contextFor(options, request, "mutate");
				const input = body(request.body);
				const ticketId = (request.params as { id: string }).id;
				const commentId = (request.params as { commentId: string }).commentId;
				if (!scopedTicket(options, context, ticketId)) return notFound(reply);
				const handler = () =>
					options.tracker.updateComment({
						ticketId,
						commentId,
						patch: {
							...(typeof input.body === "string" ? { body: input.body } : {}),
							...(typeof input.tag === "string" ? { tag: input.tag } : {}),
							...(typeof input.status === "string"
								? { status: input.status }
								: {}),
						},
						actor: context.actorId,
					});
				const outcome = gatewayRoute({
					context,
					commandKind: "legacy.comment.update",
					scope: { resourceType: "comment", resourceId: commentId },
					payload: input,
					idempotencyKey:
						typeof input.idempotency_key === "string"
							? input.idempotency_key
							: undefined,
					handler,
				});
				return outcome ?? handler();
			} catch (error) {
				return fail(reply, error);
			}
		},
	);
	options.app.post("/api/tickets/:id/links", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const ticketId = (request.params as { id: string }).id;
			if (
				!scopedTicket(options, context, ticketId) ||
				typeof input.target_ticket_id !== "string" ||
				!scopedTicket(options, context, input.target_ticket_id)
			)
				return notFound(reply);
			const handler = () =>
				options.tracker.linkTicket({
					ticketId,
					targetTicketId: input.target_ticket_id as string,
					relation: input.relation as never,
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.link.create",
				scope: { resourceType: "link", resourceId: ticketId },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.delete("/api/tickets/:id/links", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const ticketId = (request.params as { id: string }).id;
			if (
				!scopedTicket(options, context, ticketId) ||
				typeof input.target_ticket_id !== "string" ||
				!scopedTicket(options, context, input.target_ticket_id)
			)
				return notFound(reply);
			const handler = () =>
				options.tracker.deleteLink({
					ticketId,
					targetTicketId: input.target_ticket_id as string,
					relation: input.relation as never,
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.link.delete",
				scope: { resourceType: "link", resourceId: ticketId },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.get("/api/streams", async (request) => {
		const context = contextFor(options, request, "read");
		return options.tracker.listStreams(context.defaultProjectId);
	});
	options.app.post("/api/streams", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const handler = () =>
				options.tracker.upsertStream({
					...(typeof input.id === "string" ? { id: input.id } : {}),
					projectId: context.defaultProjectId,
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
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.stream.upsert",
				scope: {
					resourceType: "stream",
					resourceId: typeof input.id === "string" ? input.id : "*",
				},
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				...(typeof input.expected_revision === "number"
					? { expectedRevision: input.expected_revision }
					: {}),
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
	options.app.patch("/api/streams/:id", async (request, reply) => {
		try {
			const context = contextFor(options, request, "mutate");
			const input = body(request.body);
			const streamId = (request.params as { id: string }).id;
			if (
				!options.tracker
					.listStreams(context.defaultProjectId)
					.some((stream) => stream.id === streamId)
			)
				return notFound(reply);
			const handler = () =>
				options.tracker.upsertStream({
					id: streamId,
					projectId: context.defaultProjectId,
					name: input.name as string,
					mode: input.mode as never,
					...(typeof input.description === "string"
						? { description: input.description }
						: {}),
					...(typeof input.expected_revision === "number"
						? { expectedRevision: input.expected_revision }
						: {}),
					actor: context.actorId,
				});
			const outcome = gatewayRoute({
				context,
				commandKind: "legacy.stream.upsert",
				scope: { resourceType: "stream", resourceId: streamId },
				payload: input,
				idempotencyKey:
					typeof input.idempotency_key === "string"
						? input.idempotency_key
						: undefined,
				...(typeof input.expected_revision === "number"
					? { expectedRevision: input.expected_revision }
					: {}),
				handler,
			});
			return outcome ?? handler();
		} catch (error) {
			return fail(reply, error);
		}
	});
}
