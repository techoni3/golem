import crypto from "node:crypto";

import {
	BrowserOpaqueIdSchema,
	BrowserWorkAssetResponseSchema,
	BrowserWorkCommandResultSchema,
	BrowserWorkCommandRequestSchema,
	BrowserWorkCommandResponseSchema,
	BrowserWorkDetailResponseSchema,
	BrowserWorkErrorSchema,
	BrowserWorkStreamSchema,
} from "@golem/contracts";
import {
	type CommandGateway,
	CommandGatewayError,
	type CommandGatewayOutcome,
	TrackerCoreError,
	TrackerManagementError,
	type TicketDispatchService,
	type TrackerCoreServices,
	type TrackerManagementServices,
} from "@golem/tracker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
	type ActorContext,
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
} from "./auth.js";
import type { BrowserWorkServices } from "./browser-work-services.js";

const TicketParamsSchema = z.object({ opaque_id: BrowserOpaqueIdSchema }).strict();
const AssetParamsSchema = z
	.object({ opaque_id: BrowserOpaqueIdSchema, asset_id: BrowserOpaqueIdSchema })
	.strict();

function jsonSchema(value: z.ZodType) {
	return z.toJSONSchema(value, {
		target: "draft-7",
		unrepresentable: "any",
		reused: "inline",
	});
}

function browserFail(
	request: FastifyRequest,
	reply: FastifyReply,
	status: 400 | 401 | 403 | 404 | 409,
	code: z.infer<typeof BrowserWorkErrorSchema>["code"],
) {
	return reply.code(status).send(
		BrowserWorkErrorSchema.parse({
			schema_version: "golem.browser-work-error/v1",
			code,
			correlation_id: request.id,
		}),
	);
}

function browserContext(
	request: FastifyRequest,
	reply: FastifyReply,
	principal: BrowserPrincipalResolver,
	action: "read" | "mutate",
): ActorContext | undefined {
	if (hasRequestAuthorityOverride(request)) {
		browserFail(request, reply, 403, "browser.forbidden");
		return undefined;
	}
	const context = principal.resolve(request, {
		action,
		allowBrowser: true,
		allowBearer: false,
	});
	if (!context) {
		browserFail(request, reply, 401, "browser.auth.required");
		return undefined;
	}
	if (!principal.policy.allows(context, action)) {
		browserFail(request, reply, 403, "browser.forbidden");
		return undefined;
	}
	return context;
}

function commandFailure(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
) {
	if (error instanceof CommandGatewayError)
		return browserFail(request, reply, error.httpStatus, error.status);
	if (error instanceof TrackerCoreError) {
		const status =
			error.code === "tracker.not_found"
				? 404
				: error.code === "tracker.conflict" || error.code === "tracker.phase.invalid"
					? 409
					: 400;
		return browserFail(request, reply, status, error.code);
	}
	if (error instanceof TrackerManagementError) {
		const status =
			error.code === "management.not_found"
				? 404
				: error.code === "management.forbidden"
					? 403
					: error.code === "management.conflict"
						? 409
						: 400;
		return browserFail(request, reply, status, error.code);
	}
	return browserFail(request, reply, 400, "browser.work.invalid");
}

function outcomeResponse(
	request: FastifyRequest,
	reply: FastifyReply,
	outcome: CommandGatewayOutcome,
) {
	if (outcome.status === "idempotency_mismatch")
		return browserFail(request, reply, 409, "command.idempotency_mismatch");
	const stored = z
		.object({
			resource_revision: z.number().int().nonnegative(),
			result: BrowserWorkCommandResultSchema,
		})
		.strict()
		.safeParse(outcome.result);
	if (!stored.success) return browserFail(request, reply, 400, "browser.work.invalid");
	const response = BrowserWorkCommandResponseSchema.safeParse({
			schema_version: "golem.browser-work-command/v1",
			command_id: outcome.command_id,
			status: outcome.status,
			resource_revision: stored.data.resource_revision,
			result: stored.data.result,
		});
	return response.success
		? reply.send(response.data)
		: browserFail(request, reply, 400, "browser.work.invalid");
}

function durableBrowserOutcome(
	browserWork: BrowserWorkServices,
	projectId: string,
	result: z.infer<typeof BrowserWorkCommandResultSchema>,
) {
	return z
		.object({
			resource_revision: z.number().int().nonnegative(),
			result: BrowserWorkCommandResultSchema,
		})
		.strict()
		.parse({
			resource_revision: browserWork.projection("tracker.board", projectId)
				.resource_revision,
			result,
		});
}

/** Browser-only routes over GOL-78/79/80 application seams. */
export function registerBrowserWorkRoutes(options: {
	readonly app: FastifyInstance;
	readonly principal: BrowserPrincipalResolver;
	readonly browserWork: BrowserWorkServices;
	readonly core: TrackerCoreServices;
	readonly management: TrackerManagementServices;
	readonly gateway: CommandGateway;
	readonly ticketDispatch: TicketDispatchService;
}): void {
	const errorResponses = {
		400: jsonSchema(BrowserWorkErrorSchema),
		401: jsonSchema(BrowserWorkErrorSchema),
		403: jsonSchema(BrowserWorkErrorSchema),
		404: jsonSchema(BrowserWorkErrorSchema),
		409: jsonSchema(BrowserWorkErrorSchema),
	};

	options.app.get(
		"/api/v1/browser/work/items/:opaque_id",
		{
			schema: {
				params: jsonSchema(TicketParamsSchema),
				response: { 200: jsonSchema(BrowserWorkDetailResponseSchema), ...errorResponses },
			},
		},
		async (request, reply) => {
			const context = browserContext(request, reply, options.principal, "read");
			if (!context) return;
			const params = TicketParamsSchema.safeParse(request.params);
			if (!params.success)
				return browserFail(request, reply, 400, "browser.work.invalid");
			const detail = options.browserWork.detail(
				context.defaultProjectId,
				params.data.opaque_id,
			);
			return detail
				? reply.send(detail)
				: browserFail(request, reply, 404, "browser.work.not_found");
		},
	);

	options.app.get(
		"/api/v1/browser/work/items/:opaque_id/assets/:asset_id",
		{
			schema: {
				params: jsonSchema(AssetParamsSchema),
				response: { 200: jsonSchema(BrowserWorkAssetResponseSchema), ...errorResponses },
			},
		},
		async (request, reply) => {
			const context = browserContext(request, reply, options.principal, "read");
			if (!context) return;
			const params = AssetParamsSchema.safeParse(request.params);
			if (!params.success)
				return browserFail(request, reply, 400, "browser.work.invalid");
			try {
				const asset = options.browserWork.asset(
					context.defaultProjectId,
					params.data.opaque_id,
					params.data.asset_id,
				);
				return asset
					? reply.send(asset)
					: browserFail(request, reply, 404, "browser.work.not_found");
			} catch (error) {
				return commandFailure(request, reply, error);
			}
		},
	);

	options.app.post(
		"/api/v1/browser/work/commands",
		{
			schema: {
				response: {
					200: jsonSchema(BrowserWorkCommandResponseSchema),
					...errorResponses,
					409: jsonSchema(
						z.union([BrowserWorkCommandResponseSchema, BrowserWorkErrorSchema]),
					),
				},
			},
		},
		async (request, reply) => {
			const context = browserContext(request, reply, options.principal, "mutate");
			if (!context) return;
			const parsed = BrowserWorkCommandRequestSchema.safeParse(request.body);
			if (!parsed.success) {
				return browserFail(request, reply, 400, "browser.work.invalid");
			}
			const input = parsed.data;
			try {
				if (input.kind === "dispatch") {
					if (!options.browserWork.ticket(context.defaultProjectId, input.opaque_id))
						return browserFail(request, reply, 404, "browser.work.not_found");
					const commandId = `cmd_${crypto.randomUUID()}`;
					const result = options.gateway.execute({
							commandId,
							idempotencyKey: input.idempotency_key,
							commandKind: input.kind,
							actorId: context.actorId,
							projectId: context.defaultProjectId,
							correlationId: `cor_${crypto.randomUUID()}`,
							scope: { resourceType: "ticket", resourceId: input.opaque_id },
							expectedRevision: input.expected_revision,
							payload: input,
							handler: () =>
								durableBrowserOutcome(
									options.browserWork,
									context.defaultProjectId,
									options.ticketDispatch.dispatch({
										projectId: context.defaultProjectId,
										ticketId: input.opaque_id,
										expectedRevision: input.expected_revision,
										idempotencyKey: input.idempotency_key,
										actorId: context.actorId,
										operationId: commandId,
									}),
								),
					});
					return outcomeResponse(request, reply, result);
				}
				if (input.kind === "ticket.update" || input.kind === "ticket.transition") {
					if (!options.browserWork.ticket(context.defaultProjectId, input.opaque_id))
						return browserFail(request, reply, 404, "browser.work.not_found");
				}
				if (
					input.kind === "ticket.update" &&
					input.title === undefined &&
					input.priority === undefined &&
					input.labels === undefined
				)
					return browserFail(request, reply, 400, "browser.work.invalid");

				const result = options.gateway.execute({
					commandId: `cmd_${crypto.randomUUID()}`,
					idempotencyKey: input.idempotency_key,
					commandKind: input.kind,
					actorId: context.actorId,
					projectId: context.defaultProjectId,
					correlationId: `cor_${crypto.randomUUID()}`,
					scope: {
						resourceType: input.kind.startsWith("ticket") ? "ticket" : "gate",
						resourceId:
							input.kind === "ticket.create" || input.kind === "management.gate.create"
								? "new"
								: input.opaque_id,
					},
					...(input.kind === "ticket.update" || input.kind === "ticket.transition"
						? { expectedRevision: input.expected_revision }
						: {}),
					payload: input,
					handler: () => {
						if (input.kind === "ticket.create") {
							const ticket = options.core.tickets.create({
								projectId: context.defaultProjectId,
								kind: input.ticket_kind ?? "work-item",
								title: input.title,
								...(input.priority === undefined
									? {}
									: { priority: input.priority }),
								...(input.labels === undefined ? {} : { labels: input.labels }),
								actor: context.actorId,
							});
							const safe = options.browserWork.ticket(
								context.defaultProjectId,
								ticket.id,
							);
							if (!safe)
								throw new TrackerCoreError("tracker.not_found", "created ticket is unavailable");
							return durableBrowserOutcome(
								options.browserWork,
								context.defaultProjectId,
								{ kind: "ticket", ticket: safe },
							);
						}
						if (input.kind === "ticket.update") {
							const ticket = options.core.tickets.update({
								id: input.opaque_id,
								expectedRevision: input.expected_revision,
								patch: {
									...(input.title === undefined ? {} : { title: input.title }),
									...(input.priority === undefined
										? {}
										: { priority: input.priority }),
									...(input.labels === undefined ? {} : { labels: input.labels }),
								},
								actor: context.actorId,
							});
							const safe = options.browserWork.ticket(context.defaultProjectId, ticket.id);
							if (!safe)
								throw new TrackerCoreError("tracker.not_found", "updated ticket is unavailable");
							return durableBrowserOutcome(
								options.browserWork,
								context.defaultProjectId,
								{ kind: "ticket", ticket: safe },
							);
						}
						if (input.kind === "ticket.transition") {
							const ticket = options.core.tickets.transition({
								id: input.opaque_id,
								expectedRevision: input.expected_revision,
								phase: input.phase,
								actor: context.actorId,
							});
							const safe = options.browserWork.ticket(context.defaultProjectId, ticket.id);
							if (!safe)
								throw new TrackerCoreError("tracker.not_found", "transitioned ticket is unavailable");
							return durableBrowserOutcome(
								options.browserWork,
								context.defaultProjectId,
								{ kind: "ticket", ticket: safe },
							);
						}
						const gate = options.management.gates.create({
							projectId: context.defaultProjectId,
							kind: input.gate_kind,
							question: input.question,
							assignee: input.assignee,
							idempotencyKey: input.idempotency_key,
							actor: context.actorId,
						});
						return durableBrowserOutcome(
							options.browserWork,
							context.defaultProjectId,
							{
								kind: "gate",
								opaque_id: gate.id,
								status: gate.status,
								updated_at: gate.updatedAt,
							},
						);
					},
				});
				return outcomeResponse(request, reply, result);
			} catch (error) {
				return commandFailure(request, reply, error);
			}
		},
	);
}
