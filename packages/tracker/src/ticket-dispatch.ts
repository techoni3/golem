import type { TrackerCoreWorkItem } from "./repositories/port.js";
import type { DurableDeliveryService } from "./delivery.js";
import type { DeliveryEligibility, DeliveryEligibilityPort } from "./types.js";

/** The only command-time facts a browser/bearer/MCP adapter may supply. */
export interface TicketDispatchInput {
	readonly projectId: string;
	readonly ticketId: string;
	readonly expectedRevision: number;
	readonly idempotencyKey: string;
	readonly actorId: string;
	/** The gateway command id; it is the safe, durable operation reference. */
	readonly operationId: string;
	/** Trusted legacy compatibility hint. Browser adapters never set this. */
	readonly assigneeHint?: string;
	/** Trusted compatibility content; browser and public bearer adapters omit it. */
	readonly legacy?: {
		readonly note?: string;
		readonly workspace?: string;
		readonly whenIdle?: boolean;
	};
}

export type TicketDispatchDisposition =
	| "queued"
	| "pull_only"
	| "next_turn"
	| "ineligible"
	| "stale";

export interface TicketDispatchOutcome {
	readonly kind: "dispatch";
	readonly disposition: TicketDispatchDisposition;
	readonly operation_id: string;
	readonly capability?: "delivery";
	readonly remediation?: "await_delivery" | "await_next_turn" | "refresh_ticket";
}

export interface TicketDispatchTicketPort {
	get(projectId: string, ticketId: string): TrackerCoreWorkItem | undefined;
	record(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly dispatchedTo: string;
		readonly actor: string;
		/** Only a trusted legacy hint can fill an absent assignee. */
		readonly assignee?: string;
	}): TrackerCoreWorkItem | undefined;
}

export interface TicketDispatchSessionPort {
	resolve(projectId: string, reference: string):
		| { readonly sessionId: string; readonly generationId: string }
		| undefined;
}

function queueDisposition(
	endpoint: DeliveryEligibility | undefined,
): TicketDispatchDisposition {
	if (!endpoint) return "ineligible";
	if (endpoint.readiness === "ready") return "queued";
	if (endpoint.readiness === "pull_only") return "pull_only";
	if (endpoint.readiness === "next_turn") return "next_turn";
	return "ineligible";
}

function terminal(ticket: TrackerCoreWorkItem): boolean {
	return (
		ticket.state === "done" ||
		ticket.state === "archived" ||
		ticket.phase === "done" ||
		ticket.phase === "closed"
	);
}

function outcome(
	operationId: string,
	disposition: TicketDispatchDisposition,
): TicketDispatchOutcome {
	return Object.freeze({
		kind: "dispatch" as const,
		disposition,
		operation_id: operationId,
		...(disposition === "queued" ||
		disposition === "pull_only" ||
		disposition === "next_turn"
			? { capability: "delivery" as const }
			: {}),
		...(disposition === "pull_only"
			? { remediation: "await_delivery" as const }
			: disposition === "next_turn"
				? { remediation: "await_next_turn" as const }
				: disposition === "stale"
					? { remediation: "refresh_ticket" as const }
					: {}),
	});
}

/**
 * Canonical ticket delivery composition. It deliberately contains no HTTP,
 * MCP, browser, dashboard, or transport logic: adapters enter the enclosing
 * GOL-79 gateway transaction and invoke this service exactly once.
 */
export interface TicketDispatchService {
	dispatch(input: TicketDispatchInput): TicketDispatchOutcome;
}

export function createTicketDispatchService(options: {
	readonly tickets: TicketDispatchTicketPort;
	readonly sessions: TicketDispatchSessionPort;
	readonly eligibility: DeliveryEligibilityPort;
	readonly delivery: DurableDeliveryService;
}): TicketDispatchService {
	return Object.freeze({
		dispatch(input: TicketDispatchInput): TicketDispatchOutcome {
			const ticket = options.tickets.get(input.projectId, input.ticketId);
			if (
				!ticket ||
				ticket.projectId !== input.projectId ||
				terminal(ticket)
			)
				return outcome(input.operationId, "ineligible");

			// Current assignee alone selects the logical recipient. Historical
			// dispatchedTo and validation-only runtimeReference are never consulted.
			const hinted = input.assigneeHint
				? options.sessions.resolve(input.projectId, input.assigneeHint)
				: undefined;
			const selected = ticket.assignee
				? options.sessions.resolve(input.projectId, ticket.assignee)
				: hinted;
			if (!selected) return outcome(input.operationId, "ineligible");
			if (ticket.assignee && hinted && hinted.sessionId !== selected.sessionId)
				return outcome(input.operationId, "ineligible");

			const endpoint = options.eligibility.resolve(selected.generationId);
			const disposition = queueDisposition(endpoint);
			if (disposition === "ineligible") return outcome(input.operationId, disposition);

			// CAS first so a miss is a durable, replayable GOL-79 stale result.
			// The later envelope enqueue still runs inside the same outer gateway
			// transaction, so a changed endpoint rolls this ticket audit back too.
			const committed = options.tickets.record({
				id: ticket.id,
				expectedRevision: input.expectedRevision,
				dispatchedTo: selected.sessionId,
				actor: input.actorId,
				...(ticket.assignee === undefined ? { assignee: selected.sessionId } : {}),
			});
			if (!committed) return outcome(input.operationId, "stale");
			const envelopeId = `env_${globalThis.crypto.randomUUID()}`;
			options.delivery.enqueue({
				id: envelopeId,
				projectId: input.projectId,
				idempotencyKey: input.idempotencyKey,
				senderId: input.actorId,
				recipientId: selected.sessionId,
				eligibilityRecipientId: selected.generationId,
				kind: "ticket_dispatch",
				payload: Object.freeze({
					ticket_id: ticket.id,
					...(input.legacy?.note === undefined
						? {}
						: { note: input.legacy.note }),
					...(input.legacy?.workspace === undefined
						? {}
						: { workspace: input.legacy.workspace }),
					...(input.legacy?.whenIdle === undefined
						? {}
						: { when_idle: input.legacy.whenIdle }),
				}),
			});
			return outcome(input.operationId, disposition);
		},
	});
}
