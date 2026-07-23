import {
	BrowserWorkAssetResponseSchema,
	BrowserWorkDetailResponseSchema,
	BrowserWorkDispatchOperationSchema,
	BrowserWorkManagementOperationSchema,
	BrowserWorkProjectionCursorSchema,
	type BrowserWorkProjectionResponse,
	BrowserWorkProjectionResponseSchema,
	type BrowserWorkStreamSchema,
	BrowserWorkTicketSchema,
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

function ticketView(ticket: {
	readonly id: string;
	readonly kind: "work-item" | "spec" | "question" | "decision" | "fix";
	readonly state:
		| "todo"
		| "in_progress"
		| "blocked"
		| "review"
		| "done"
		| "archived";
	readonly phase: string;
	readonly priority: "P0" | "P1" | "P2" | "P3" | null;
	readonly revision: number;
	readonly updatedAt: string;
}): BrowserTicket {
	return BrowserWorkTicketSchema.parse({
		opaque_id: ticket.id,
		kind: ticket.kind,
		state: ticket.state,
		phase: ticket.phase,
		priority: ticket.priority,
		revision: ticket.revision,
		updated_at: ticket.updatedAt,
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
			end < items.length ? BrowserWorkProjectionCursorSchema.parse(`bwp_${page + 1}`) : null,
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
	detail(projectId: string, ticketId: string): ReturnType<
		typeof BrowserWorkDetailResponseSchema.parse
	> | undefined;
	asset(
		projectId: string,
		ticketId: string,
		assetId: string,
	): ReturnType<typeof BrowserWorkAssetResponseSchema.parse> | undefined;
	ticket(projectId: string, ticketId: string): BrowserTicket | undefined;
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

	const service: BrowserWorkServices = {
		projection(stream: BrowserWorkStream, projectId: string, cursor?: string) {
			const resourceRevision = options.projectRevision(projectId);
			if (stream === "tracker.board") {
				const page = boundedPage(options.core.tickets.list({ projectId }), cursor);
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: page.nextCursor,
					items: page.items.map(ticketView),
				});
			}
			if (stream === "tracker.tree") {
				const tickets = options.core.tickets.list({ projectId });
				const visible = new Set(tickets.map((ticket) => ticket.id));
				const page = boundedPage(tickets, cursor);
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: page.nextCursor,
					items: page.items.map((ticket) => ({
						...ticketView(ticket),
						...(ticket.parentId && visible.has(ticket.parentId)
							? { parent_opaque_id: ticket.parentId }
							: {}),
					})),
				});
			}
			const managementOperations = options.management.controls.list(projectId);
			const items =
				stream === "management.controls"
					? managementOperations
							.filter((operation) => operation.kind === "control")
							.map(managementOperationView)
					: [
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
			return detail
				? BrowserWorkDetailResponseSchema.parse({
						schema_version: "golem.browser-work-detail/v1",
						item: ticketView(detail.ticket),
					})
				: undefined;
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
				asset: {
					opaque_id: value.asset.id,
					mime_type: value.asset.mimeType,
					byte_size: value.asset.byteSize,
					created_at: value.asset.createdAt,
				},
				content_base64: Buffer.from(value.bytes).toString("base64"),
			});
		},
		ticket(projectId: string, ticketId: string) {
			const detail = scopedTicket(projectId, ticketId);
			return detail ? ticketView(detail.ticket) : undefined;
		},
	};
	return Object.freeze(service);
}
