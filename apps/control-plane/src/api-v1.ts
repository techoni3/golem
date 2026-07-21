import crypto from "node:crypto";

import type {
	TrackerCoreError,
	TrackerCoreServices,
	TrackerServices,
} from "@golem/tracker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { bearerIsValid } from "./auth.js";
import { fail } from "./errors.js";

type JsonRecord = Record<string, unknown>;
type Caller = Readonly<{
	projectId: string;
	actor: string;
	sessionId?: string;
}>;

function record(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function value(request: FastifyRequest): JsonRecord {
	return record(request.body);
}

function headerValue(
	request: FastifyRequest,
	names: readonly string[],
): string | undefined {
	const values = names
		.map((name) => request.headers[name])
		.filter(
			(candidate): candidate is string =>
				typeof candidate === "string" && candidate.trim().length > 0,
		)
		.map((candidate) => candidate.trim());
	if (new Set(values).size > 1) throw new Error("caller.identity.ambiguous");
	return values[0];
}

function caller(
	request: FastifyRequest,
	reply: FastifyReply,
): Caller | undefined {
	try {
		const projectId = headerValue(request, [
			"x-golem-caller-project",
			"x-golem-project-id",
		]);
		const actor = headerValue(request, [
			"x-golem-caller-actor",
			"x-golem-actor",
		]);
		const sessionId = headerValue(request, [
			"x-golem-caller-session",
			"x-golem-session-id",
		]);
		if (!projectId || !actor) {
			fail(
				request,
				reply,
				403,
				"caller.identity.required",
				"an explicit trusted caller identity is required",
			);
			return undefined;
		}
		return Object.freeze({
			projectId,
			actor,
			...(sessionId ? { sessionId } : {}),
		});
	} catch (_error) {
		fail(
			request,
			reply,
			403,
			"caller.identity.ambiguous",
			"caller identity is ambiguous",
		);
		return undefined;
	}
}

function rejectForgedIdentity(
	input: JsonRecord,
	callerValue: Caller,
): string | undefined {
	for (const key of [
		"actor",
		"created_by",
		"createdBy",
		"session_id",
		"sessionId",
	]) {
		if (key in input)
			return "caller identity is process-composed and cannot be supplied in request JSON";
	}
	for (const key of ["project_id", "projectId"]) {
		if (key in input && input[key] !== callerValue.projectId)
			return "request project does not match the trusted caller project";
	}
	return undefined;
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
	return 400;
}

function errorCode(error: unknown): string {
	const code = (error as Partial<TrackerCoreError>)?.code;
	return typeof code === "string" ? code : "api.request.invalid";
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
	readonly token: string;
	readonly core: TrackerCoreServices;
	readonly services: TrackerServices;
}): void {
	const claims = new Map<string, ClaimRecord>();
	const idempotent = new Map<string, unknown>();
	const subscriptions = new Map<
		string,
		ReturnType<TrackerServices["subscriptions"]["subscribe"]>
	>();
	const busEvents: unknown[] = [];
	const guard = (
		request: FastifyRequest,
		reply: FastifyReply,
	): Caller | undefined => {
		if (!bearerIsValid(request, options.token)) {
			fail(
				request,
				reply,
				401,
				"auth.invalid",
				"a valid bearer token is required",
			);
			return undefined;
		}
		return caller(request, reply);
	};
	const withIdentity = (
		request: FastifyRequest,
		reply: FastifyReply,
		callerValue: Caller,
	): JsonRecord | undefined => {
		const input = value(request);
		const forged = rejectForgedIdentity(input, callerValue);
		if (forged) {
			fail(request, reply, 403, "caller.identity.spoofed", forged);
			return undefined;
		}
		return input;
	};

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
			const key =
				typeof input.idempotency_key === "string"
					? `${callerValue.projectId}:${input.idempotency_key}`
					: undefined;
			if (key && idempotent.has(key)) return reply.send(idempotent.get(key));
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
			if (key) idempotent.set(key, result);
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
				const ticket = options.core.compatibility.getTicket(id);
				if (!ticket || ticket.project_id !== callerValue.projectId)
					return fail(
						request,
						reply,
						404,
						"tracker.not_found",
						"ticket was not found",
					);
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
				const ticket = options.core.compatibility.getTicket(params.id);
				if (!ticket || ticket.project_id !== callerValue.projectId)
					return fail(
						request,
						reply,
						404,
						"tracker.not_found",
						"ticket was not found",
					);
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
				recipientId: callerValue.sessionId || callerValue.actor,
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
		const recipientId = callerValue.sessionId || callerValue.actor;
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
			const recipientId = callerValue.sessionId || callerValue.actor;
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
