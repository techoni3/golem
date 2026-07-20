import type { TrackerCoreServices } from "./core.js";
import type {
	TrackerCoreActorContext,
	TrackerCoreComment,
	TrackerCoreLink,
	TrackerCoreStream,
	TrackerCoreWorkItem,
} from "./repositories/port.js";
import { TrackerCoreError } from "./tickets/service.js";

function legacyTicket(ticket: TrackerCoreWorkItem) {
	return Object.freeze({
		id: ticket.id,
		display_id: ticket.displayId,
		project_id: ticket.projectId,
		kind: ticket.kind,
		title: ticket.title,
		body: ticket.body,
		priority: ticket.priority,
		labels: ticket.labels,
		stream_id: ticket.streamId ?? null,
		parent_id: ticket.parentId ?? null,
		assignee: ticket.assignee ?? null,
		dispatched_to: ticket.dispatchedTo ?? null,
		dispatched_at: ticket.dispatchedAt ?? null,
		state: ticket.state,
		phase: ticket.phase,
		rank: ticket.rank,
		wave: ticket.wave ?? null,
		revision: ticket.revision,
		created_by: ticket.createdBy,
		created_at: ticket.createdAt,
		updated_at: ticket.updatedAt,
	});
}

function legacyComment(comment: TrackerCoreComment) {
	const anchor = comment.anchor ?? {};
	return Object.freeze({
		id: comment.id,
		ticket_id: comment.ticketId,
		parent_id: comment.parentId ?? null,
		author: comment.author,
		body: comment.body,
		quote: anchor.quote ?? null,
		prefix: anchor.prefix ?? null,
		suffix: anchor.suffix ?? null,
		section: anchor.section ?? null,
		section_id: anchor.sectionId ?? null,
		tag: comment.tag,
		status: comment.status,
		dispatch_state: comment.dispatchState,
		created_at: comment.createdAt,
		updated_at: comment.updatedAt,
	});
}

function legacyLink(link: TrackerCoreLink) {
	return Object.freeze({
		from_ticket: link.ticketId,
		to_ticket: link.targetTicketId,
		type: link.relation,
	});
}

function legacyStream(stream: TrackerCoreStream) {
	return Object.freeze({
		id: stream.id,
		project_id: stream.projectId,
		name: stream.name,
		mode: stream.mode,
		description: stream.description,
		revision: stream.revision,
		created_at: stream.createdAt,
		updated_at: stream.updatedAt,
	});
}

/**
 * C1–C3 shape adapter for existing dashboard REST routes and tracker-client.
 * It owns no database access and exposes no runtime readiness decision.
 */
export interface TrackerCompatibilityFacade {
	createTicket(
		input: Parameters<TrackerCoreServices["tickets"]["create"]>[0],
	): ReturnType<typeof legacyTicket>;
	getTicket(id: string):
		| Readonly<{
				readonly comments: readonly ReturnType<typeof legacyComment>[];
				readonly id: string;
				readonly links: readonly ReturnType<typeof legacyLink>[];
				readonly [key: string]: unknown;
		  }>
		| undefined;
	listTickets(
		input?: Parameters<TrackerCoreServices["tickets"]["list"]>[0],
	): readonly ReturnType<typeof legacyTicket>[];
	searchTickets(
		query: string,
		projectId?: string,
	): readonly ReturnType<typeof legacyTicket>[];
	updateTicket(
		input: Parameters<TrackerCoreServices["tickets"]["update"]>[0],
	): ReturnType<typeof legacyTicket>;
	transitionTicket(
		input: Parameters<TrackerCoreServices["tickets"]["transition"]>[0],
	): ReturnType<typeof legacyTicket>;
	exceptionalCloseTicket(
		input: Readonly<{
			readonly id: string;
			readonly expectedRevision: number;
			readonly reason: string;
		}>,
	): ReturnType<typeof legacyTicket>;
	addComment(
		input: Parameters<TrackerCoreServices["comments"]["add"]>[0],
	): ReturnType<typeof legacyComment>;
	updateComment(
		input: Parameters<TrackerCoreServices["comments"]["update"]>[0],
	): ReturnType<typeof legacyComment>;
	replyComment(
		input: Parameters<TrackerCoreServices["comments"]["reply"]>[0],
	): ReturnType<typeof legacyComment>;
	linkTicket(
		input: Parameters<TrackerCoreServices["links"]["create"]>[0],
	): ReturnType<typeof legacyLink>;
	deleteLink(
		input: Parameters<TrackerCoreServices["links"]["delete"]>[0],
	): Readonly<{ readonly removed: number }>;
	upsertStream(
		input: Parameters<TrackerCoreServices["streams"]["upsert"]>[0],
	): ReturnType<typeof legacyStream>;
	listStreams(projectId?: string): readonly ReturnType<typeof legacyStream>[];
}

export function createTrackerCompatibilityFacade(
	services: TrackerCoreServices,
	options: Readonly<{
		/**
		 * Authority is injected by the authenticated application composition
		 * boundary. It is deliberately absent from request-shaped inputs and
		 * from the generic MCP/control-plane composition.
		 */
		readonly trustedExceptionalCloseContext?: TrackerCoreActorContext;
	}> = {},
): TrackerCompatibilityFacade {
	const facade: TrackerCompatibilityFacade = {
		createTicket: (
			input: Parameters<TrackerCoreServices["tickets"]["create"]>[0],
		) => legacyTicket(services.tickets.create(input)),
		getTicket(id: string) {
			const detail = services.tickets.get(id);
			if (!detail) return undefined;
			return Object.freeze({
				...legacyTicket(detail.ticket),
				comments: Object.freeze(detail.comments.map(legacyComment)),
				links: Object.freeze(detail.links.map(legacyLink)),
			});
		},
		listTickets: (
			input?: Parameters<TrackerCoreServices["tickets"]["list"]>[0],
		) => Object.freeze(services.tickets.list(input).map(legacyTicket)),
		searchTickets: (query: string, projectId?: string) =>
			Object.freeze(
				services.tickets.search(query, projectId).map(legacyTicket),
			),
		updateTicket: (
			input: Parameters<TrackerCoreServices["tickets"]["update"]>[0],
		) => legacyTicket(services.tickets.update(input)),
		transitionTicket: (
			input: Parameters<TrackerCoreServices["tickets"]["transition"]>[0],
		) => legacyTicket(services.tickets.transition(input)),
		exceptionalCloseTicket: (input) => {
			const context = options.trustedExceptionalCloseContext;
			if (!context)
				throw new TrackerCoreError(
					"tracker.phase.invalid",
					"exceptional close requires a verified authenticated authority",
				);
			const keys = Object.keys(input);
			if (
				keys.some((key) => !["id", "expectedRevision", "reason"].includes(key))
			)
				throw new TrackerCoreError(
					"tracker.phase.invalid",
					"exceptional close authority is server-owned",
				);
			if (
				typeof input.id !== "string" ||
				!Number.isSafeInteger(input.expectedRevision) ||
				input.expectedRevision < 1 ||
				typeof input.reason !== "string" ||
				input.reason.trim().length === 0
			)
				throw new TrackerCoreError(
					"tracker.phase.invalid",
					"exceptional close requires id, expected revision, and reason",
				);
			return legacyTicket(
				services.tickets.exceptionalClose({
					id: input.id,
					expectedRevision: input.expectedRevision,
					reason: input.reason,
					actorContext: context,
				}),
			);
		},
		addComment: (
			input: Parameters<TrackerCoreServices["comments"]["add"]>[0],
		) => legacyComment(services.comments.add(input)),
		updateComment: (
			input: Parameters<TrackerCoreServices["comments"]["update"]>[0],
		) => legacyComment(services.comments.update(input)),
		replyComment: (
			input: Parameters<TrackerCoreServices["comments"]["reply"]>[0],
		) => legacyComment(services.comments.reply(input)),
		linkTicket: (
			input: Parameters<TrackerCoreServices["links"]["create"]>[0],
		) => legacyLink(services.links.create(input)),
		deleteLink: (
			input: Parameters<TrackerCoreServices["links"]["delete"]>[0],
		) => Object.freeze({ removed: services.links.delete(input) ? 1 : 0 }),
		upsertStream: (
			input: Parameters<TrackerCoreServices["streams"]["upsert"]>[0],
		) => legacyStream(services.streams.upsert(input)),
		listStreams: (projectId?: string) =>
			Object.freeze(services.streams.list(projectId).map(legacyStream)),
	};
	return Object.freeze(facade);
}
