import crypto from "node:crypto";

import {
	BrowserOpaqueIdSchema,
	BrowserWorkAssetMetadataSchema,
	BrowserWorkAssetResponseSchema,
	BrowserWorkCommentSchema,
	BrowserWorkDetailResponseSchema,
	BrowserWorkDispatchOperationSchema,
	BrowserWorkGateSchema,
	BrowserWorkIdeaSchema,
	BrowserWorkLinkSchema,
	BrowserWorkManagementOperationSchema,
	BrowserWorkProjectionCursorSchema,
	type BrowserWorkProjectionResponse,
	BrowserWorkProjectionResponseSchema,
	BrowserWorkRoleSchema,
	type BrowserWorkStreamSchema,
	BrowserWorkTicketSchema,
	BrowserWorkTrackerStreamSchema,
} from "@golem/contracts";
import type {
	TicketDispatchService,
	TrackerCoreServices,
	TrackerManagementServices,
} from "@golem/tracker";
import type { z } from "zod";

type BrowserWorkStream = z.infer<typeof BrowserWorkStreamSchema>;
type BrowserTicket = z.infer<typeof BrowserWorkTicketSchema>;
const browserPageSize = 100;

function safeBrowserText(value: string, maximum: number): string {
	return value
		.replace(/\bprompt\b[^\r\n]*/giu, "[REDACTED_PROMPT]")
		.replace(
			/\b(prompt|cookie|csrf|bearer|fence)\s*:[^\r\n]*/giu,
			"$1: [REDACTED]",
		)
		.replace(/\bcommand\s+prose\b[^\r\n]*/giu, "[REDACTED_COMMAND]")
		.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
		.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
		.replace(/(?:^|\s)(?:~\/|\/)[^\s]+/gu, " [REDACTED_PATH]")
		.slice(0, maximum);
}

function authorKind(author: string): "human" | "session" | "system" {
	if (author === "human" || author.startsWith("human:")) return "human";
	if (
		author.startsWith("ses_") ||
		author.startsWith("codex-") ||
		author.startsWith("claude-")
	)
		return "session";
	return "system";
}

function ticketView(
	ticket: {
		readonly id: string;
		readonly kind: "work-item" | "spec" | "question" | "decision" | "fix";
		readonly title: string;
		readonly state:
			| "todo"
			| "in_progress"
			| "blocked"
			| "review"
			| "done"
			| "archived";
		readonly phase: string;
		readonly priority: "P0" | "P1" | "P2" | "P3" | null;
		readonly labels: readonly string[];
		readonly parentId?: string;
		readonly streamId?: string;
		readonly wave?: number;
		readonly assignee?: string;
		readonly revision: number;
		readonly updatedAt: string;
	},
	legalPhases: readonly string[],
	visibleIds?: ReadonlySet<string>,
	visibleStreamIds?: ReadonlySet<string>,
): BrowserTicket {
	return BrowserWorkTicketSchema.parse({
		opaque_id: ticket.id,
		kind: ticket.kind,
		title: safeBrowserText(ticket.title, 256) || "Untitled",
		state: ticket.state,
		phase: ticket.phase,
		priority: ticket.priority,
		labels: ticket.labels.map(
			(label) => safeBrowserText(label, 64) || "[REDACTED]",
		),
		...(ticket.parentId && (!visibleIds || visibleIds.has(ticket.parentId))
			? { parent_opaque_id: ticket.parentId }
			: {}),
		...(ticket.streamId &&
		(!visibleStreamIds || visibleStreamIds.has(ticket.streamId))
			? { stream_opaque_id: ticket.streamId }
			: {}),
		...(ticket.wave === undefined ? {} : { wave: ticket.wave }),
		legal_phases: legalPhases,
		has_assignee: ticket.assignee !== undefined,
		revision: ticket.revision,
		updated_at: ticket.updatedAt,
	});
}

export function browserWorkCommentView(comment: {
	readonly id: string;
	readonly parentId?: string;
	readonly author: string;
	readonly body: string;
	readonly tag: string;
	readonly status: string;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}) {
	return BrowserWorkCommentSchema.parse({
		opaque_id: comment.id,
		...(comment.parentId ? { parent_opaque_id: comment.parentId } : {}),
		author_kind: authorKind(comment.author),
		body: safeBrowserText(comment.body, 16_384),
		tag: safeBrowserText(comment.tag, 64) || "note",
		status: safeBrowserText(comment.status, 64) || "open",
		revision: comment.revision,
		created_at: comment.createdAt,
		updated_at: comment.updatedAt,
	});
}

export function browserWorkLinkView(
	link: {
		readonly id: string;
		readonly ticketId?: string;
		readonly targetTicketId: string;
		readonly relation: "blocks" | "relates" | "duplicates";
		readonly createdAt: string;
	},
	subjectTicketId?: string,
) {
	const opaqueId = BrowserOpaqueIdSchema.safeParse(link.id).success
		? link.id
		: `lnk_${crypto.createHash("sha256").update(link.id).digest("hex").slice(0, 24)}`;
	const targetTicketId =
		subjectTicketId && link.ticketId && link.ticketId !== subjectTicketId
			? link.ticketId
			: link.targetTicketId;
	return BrowserWorkLinkSchema.parse({
		opaque_id: opaqueId,
		target_opaque_id: targetTicketId,
		relation: link.relation,
		...(link.createdAt ? { created_at: link.createdAt } : {}),
	});
}

export function browserWorkStreamView(stream: {
	readonly id: string;
	readonly name: string;
	readonly mode: "sequential" | "parallel";
	readonly description: string;
	readonly revision: number;
	readonly updatedAt: string;
}) {
	return BrowserWorkTrackerStreamSchema.parse({
		opaque_id: stream.id,
		name: safeBrowserText(stream.name, 256) || "Untitled stream",
		mode: stream.mode,
		description: safeBrowserText(stream.description, 4_096),
		revision: stream.revision,
		updated_at: stream.updatedAt,
	});
}

export function browserWorkIdeaView(idea: {
	readonly id: string;
	readonly body: string;
	readonly status: "pending" | "popped" | "promoted";
	readonly promotedTicketId?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}) {
	return BrowserWorkIdeaSchema.parse({
		opaque_id: idea.id,
		body: safeBrowserText(idea.body, 16_384),
		status: idea.status,
		...(idea.promotedTicketId
			? { promoted_ticket_opaque_id: idea.promotedTicketId }
			: {}),
		created_at: idea.createdAt,
		updated_at: idea.updatedAt,
	});
}

function assetMetadataView(asset: {
	readonly id: string;
	readonly mimeType: string;
	readonly byteSize: number;
	readonly createdAt: string;
}) {
	return BrowserWorkAssetMetadataSchema.parse({
		opaque_id: asset.id,
		mime_type: asset.mimeType,
		byte_size: asset.byteSize,
		created_at: asset.createdAt,
	});
}

function managementOperationView(operation: {
	readonly id: string;
	readonly kind: "chat" | "brief" | "interrupt" | "halt" | "control";
	readonly status: "queued" | "ineligible" | "delivered";
	readonly createdAt: string;
	readonly updatedAt: string;
}) {
	return BrowserWorkManagementOperationSchema.parse({
		opaque_id: operation.id,
		operation_kind: operation.kind,
		status: operation.status,
		created_at: operation.createdAt,
		updated_at: operation.updatedAt,
	});
}

function dispatchOperationView(operation: {
	readonly id: string;
	readonly ticketId: string;
	readonly disposition:
		| "queued"
		| "pull_only"
		| "next_turn"
		| "ineligible"
		| "stale";
	readonly capability?: "delivery";
	readonly remediation?:
		| "await_delivery"
		| "await_next_turn"
		| "refresh_ticket";
	readonly settlement?:
		| "pending"
		| "delivered"
		| "settled"
		| "retrying"
		| "failed"
		| "expired"
		| "cancelled";
	readonly createdAt: string;
}) {
	const parsed = BrowserWorkDispatchOperationSchema.safeParse({
		opaque_id: operation.id,
		operation_kind: "dispatch",
		subject_opaque_id: operation.ticketId,
		disposition: operation.disposition,
		...(operation.capability ? { capability: operation.capability } : {}),
		...(operation.remediation ? { remediation: operation.remediation } : {}),
		...(operation.settlement ? { settlement: operation.settlement } : {}),
		created_at: operation.createdAt,
	});
	return parsed.success ? parsed.data : undefined;
}

function descendingOperation(
	left: { readonly opaque_id: string; readonly created_at: string },
	right: { readonly opaque_id: string; readonly created_at: string },
): number {
	return (
		right.created_at.localeCompare(left.created_at) ||
		right.opaque_id.localeCompare(left.opaque_id)
	);
}

function pageOf(cursor: string | undefined): number {
	if (!cursor) return 0;
	return Number(BrowserWorkProjectionCursorSchema.parse(cursor).slice(4));
}

function boundedPage<T>(items: readonly T[], cursor: string | undefined) {
	const page = pageOf(cursor);
	const start = page * browserPageSize;
	const end = start + browserPageSize;
	return Object.freeze({
		items: items.slice(start, end),
		nextCursor:
			end < items.length
				? BrowserWorkProjectionCursorSchema.parse(`bwp_${page + 1}`)
				: null,
	});
}

/**
 * Read-only allowlist adapter over composed application services.  It owns no
 * authority, database, revision counter, or projection cache; the caller
 * supplies the GOL-80 canonical project revision reader.
 */
export interface BrowserWorkServices {
	projection(
		stream: BrowserWorkStream,
		projectId: string,
		cursor?: string,
	): BrowserWorkProjectionResponse;
	detail(
		projectId: string,
		ticketId: string,
	): ReturnType<typeof BrowserWorkDetailResponseSchema.parse> | undefined;
	asset(
		projectId: string,
		ticketId: string,
		assetId: string,
	): ReturnType<typeof BrowserWorkAssetResponseSchema.parse> | undefined;
	ticket(projectId: string, ticketId: string): BrowserTicket | undefined;
	idea(
		projectId: string,
		ideaId: string,
	): ReturnType<typeof BrowserWorkIdeaSchema.parse> | undefined;
}

export function createBrowserWorkServices(options: {
	readonly core: TrackerCoreServices;
	readonly management: TrackerManagementServices;
	readonly ticketDispatch: TicketDispatchService;
	readonly projectRevision: (projectId: string) => number;
}): BrowserWorkServices {
	function scopedTicket(projectId: string, ticketId: string) {
		const detail = options.core.tickets.get(ticketId);
		return detail?.ticket.projectId === projectId ? detail : undefined;
	}

	function visibleTickets(projectId: string) {
		const tickets = options.core.tickets.list({ projectId });
		const streams = options.core.streams.list(projectId);
		return {
			tickets,
			ids: new Set(tickets.map((ticket) => ticket.id)),
			streams,
			streamIds: new Set(streams.map((stream) => stream.id)),
		};
	}

	function safeTicket(
		ticket: Parameters<typeof ticketView>[0],
		visibleIds?: ReadonlySet<string>,
		visibleStreamIds?: ReadonlySet<string>,
	) {
		return ticketView(
			ticket,
			options.core.tickets.legalTransitions(ticket.id),
			visibleIds,
			visibleStreamIds,
		);
	}

	const service: BrowserWorkServices = {
		projection(stream: BrowserWorkStream, projectId: string, cursor?: string) {
			const resourceRevision = options.projectRevision(projectId);
			if (stream === "tracker.board") {
				const visible = visibleTickets(projectId);
				const page = boundedPage(visible.tickets, cursor);
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: page.nextCursor,
					items: page.items.map((ticket) =>
						safeTicket(ticket, visible.ids, visible.streamIds),
					),
				});
			}
			if (stream === "tracker.tree") {
				const visible = visibleTickets(projectId);
				const page = boundedPage(visible.tickets, cursor);
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: page.nextCursor,
					items: page.items.map((ticket) =>
						safeTicket(ticket, visible.ids, visible.streamIds),
					),
				});
			}
			const managementOperations = options.management.controls.list(projectId);
			if (stream === "management.controls") {
				const page = boundedPage(
					managementOperations
						.filter((operation) => operation.kind === "control")
						.map(managementOperationView),
					cursor,
				);
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: page.nextCursor,
					items: page.items,
					roles: options.management.roles
						.list(projectId)
						.slice(0, browserPageSize)
						.map((role) =>
							BrowserWorkRoleSchema.parse({
								opaque_id: role.id,
								name: safeBrowserText(role.name, 128) || "Untitled role",
								scope: role.scope,
								revision: role.revision,
								updated_at: role.updatedAt,
							}),
						),
					gates: options.management.gates
						.list(projectId)
						.slice(0, browserPageSize)
						.map((gate) =>
							BrowserWorkGateSchema.parse({
								opaque_id: gate.id,
								gate_kind: gate.kind,
								status: gate.status,
								question: safeBrowserText(gate.question, 4_096) || "[REDACTED]",
								assignee_kind:
									gate.assignee === "human" ||
									gate.assignee.startsWith("human:")
										? "human"
										: "operator",
								updated_at: gate.updatedAt,
							}),
						),
					ideas: options.management.ideas
						.list(projectId)
						.slice(0, browserPageSize)
						.map(browserWorkIdeaView),
				});
			}
			const items = [
				...managementOperations
					.filter((operation) => operation.kind !== "control")
					.map(managementOperationView),
				...options.ticketDispatch
					.operations(projectId)
					.map(dispatchOperationView)
					.filter((operation) => operation !== undefined),
			].sort(descendingOperation);
			const page = boundedPage(items, cursor);
			return BrowserWorkProjectionResponseSchema.parse({
				schema_version: "golem.browser-work-projection/v1",
				stream,
				resource_revision: resourceRevision,
				next_cursor: page.nextCursor,
				items: page.items,
			});
		},
		detail(projectId: string, ticketId: string) {
			const detail = scopedTicket(projectId, ticketId);
			if (!detail) return undefined;
			const visible = visibleTickets(projectId);
			return BrowserWorkDetailResponseSchema.parse({
				schema_version: "golem.browser-work-detail/v1",
				item: safeTicket(detail.ticket, visible.ids, visible.streamIds),
				body: safeBrowserText(detail.ticket.body, 16_384),
				comments: detail.comments.slice(0, 500).map(browserWorkCommentView),
				links: detail.links
					.filter(
						(link) =>
							visible.ids.has(link.ticketId) &&
							visible.ids.has(link.targetTicketId),
					)
					.slice(0, 200)
					.map((link) => browserWorkLinkView(link, ticketId)),
				children: visible.tickets
					.filter((ticket) => ticket.parentId === ticketId)
					.slice(0, 200)
					.map((ticket) => safeTicket(ticket, visible.ids, visible.streamIds)),
				streams: visible.streams
					.slice(0, browserPageSize)
					.map(browserWorkStreamView),
				assets: options.management.assets
					.list({ projectId, ticketId })
					.slice(0, browserPageSize)
					.map(assetMetadataView),
			});
		},
		asset(projectId: string, ticketId: string, assetId: string) {
			if (!scopedTicket(projectId, ticketId)) return undefined;
			const value = options.management.assets.read({
				projectId,
				ticketId,
				assetId,
			});
			return BrowserWorkAssetResponseSchema.parse({
				schema_version: "golem.browser-work-asset/v1",
				asset: assetMetadataView(value.asset),
				content_base64: Buffer.from(value.bytes).toString("base64"),
			});
		},
		ticket(projectId: string, ticketId: string) {
			const detail = scopedTicket(projectId, ticketId);
			if (!detail) return undefined;
			const visible = visibleTickets(projectId);
			return safeTicket(detail.ticket, visible.ids, visible.streamIds);
		},
		idea(projectId: string, ideaId: string) {
			const idea = options.management.ideas
				.list(projectId)
				.find((candidate) => candidate.id === ideaId);
			return idea ? browserWorkIdeaView(idea) : undefined;
		},
	};
	return Object.freeze(service);
}
