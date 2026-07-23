import {
	BrowserWorkAssetResponseSchema,
	BrowserWorkDetailResponseSchema,
	BrowserWorkProjectionResponseSchema,
	BrowserWorkTicketSchema,
	type BrowserWorkProjectionResponse,
	type BrowserWorkStreamSchema,
} from "@golem/contracts";
import type {
	TrackerCoreServices,
	TrackerManagementServices,
} from "@golem/tracker";
import type { z } from "zod";

type BrowserWorkStream = z.infer<typeof BrowserWorkStreamSchema>;
type BrowserTicket = z.infer<typeof BrowserWorkTicketSchema>;

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

function operationView(operation: {
	readonly id: string;
	readonly kind: "chat" | "brief" | "interrupt" | "halt" | "control";
	readonly status: "queued" | "ineligible" | "delivered";
	readonly createdAt: string;
	readonly updatedAt: string;
}) {
	return {
		opaque_id: operation.id,
		operation_kind: operation.kind,
		status: operation.status,
		created_at: operation.createdAt,
		updated_at: operation.updatedAt,
	} as const;
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
	readonly projectRevision: (projectId: string) => number;
}): BrowserWorkServices {
	function scopedTicket(projectId: string, ticketId: string) {
		const detail = options.core.tickets.get(ticketId);
		return detail?.ticket.projectId === projectId ? detail : undefined;
	}

	const service: BrowserWorkServices = {
		projection(stream: BrowserWorkStream, projectId: string) {
			const resourceRevision = options.projectRevision(projectId);
			if (stream === "tracker.board") {
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: null,
					items: options.core.tickets
						.list({ projectId })
						.slice(0, 100)
						.map(ticketView),
				});
			}
			if (stream === "tracker.tree") {
				const tickets = options.core.tickets.list({ projectId });
				const visible = new Set(tickets.map((ticket) => ticket.id));
				return BrowserWorkProjectionResponseSchema.parse({
					schema_version: "golem.browser-work-projection/v1",
					stream,
					resource_revision: resourceRevision,
					next_cursor: null,
					items: tickets.slice(0, 100).map((ticket) => ({
						...ticketView(ticket),
						...(ticket.parentId && visible.has(ticket.parentId)
							? { parent_opaque_id: ticket.parentId }
							: {}),
					})),
				});
			}
			const operations = options.management.controls.list(projectId);
			return BrowserWorkProjectionResponseSchema.parse({
				schema_version: "golem.browser-work-projection/v1",
				stream,
				resource_revision: resourceRevision,
				next_cursor: null,
				items: operations
					.filter((operation) =>
						stream === "management.controls"
							? operation.kind === "control"
							: operation.kind !== "control",
					)
					.slice(0, 100)
					.map(operationView),
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
