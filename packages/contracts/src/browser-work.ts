import { z } from "zod";

import { ControlPlaneInstanceIdSchema } from "./ids.js";
import { wireVersion } from "./version.js";

export const BrowserOpaqueIdSchema = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
	.max(128);
const BrowserTimestampSchema = z.iso.datetime({ offset: true });
const BrowserTicketKindSchema = z.enum([
	"work-item",
	"spec",
	"question",
	"decision",
	"fix",
]);
const BrowserTicketStateSchema = z.enum([
	"todo",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
]);
const BrowserTicketPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
const BrowserTitleSchema = z.string().min(1).max(256);
const BrowserBodySchema = z.string().max(16_384);
const BrowserLabelSchema = z.string().min(1).max(64);
const BrowserPhaseSchema = z.string().min(1).max(64);
const BrowserOperationStatusSchema = z.enum([
	"queued",
	"ineligible",
	"delivered",
]);

export const BrowserWorkStreamSchema = z.enum([
	"tracker.board",
	"tracker.tree",
	"management.controls",
	"communication.operations",
]);

/** Server-composed page cursor, independent of GOL-80 publication cursors. */
export const BrowserWorkProjectionCursorSchema = z
	.string()
	.regex(/^bwp_[0-9]{1,8}$/u)
	.max(12);

export const BrowserWorkProjectionQuerySchema = z
	.object({ cursor: BrowserWorkProjectionCursorSchema.optional() })
	.strict();

export const BrowserWorkTicketSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		kind: BrowserTicketKindSchema,
		title: BrowserTitleSchema,
		state: BrowserTicketStateSchema,
		phase: BrowserPhaseSchema,
		priority: BrowserTicketPrioritySchema.nullable(),
		labels: z.array(BrowserLabelSchema).max(32),
		parent_opaque_id: BrowserOpaqueIdSchema.optional(),
		stream_opaque_id: BrowserOpaqueIdSchema.optional(),
		wave: z.number().int().positive().max(10_000).optional(),
		legal_phases: z.array(BrowserPhaseSchema).max(16),
		has_assignee: z.boolean(),
		revision: z.number().int().positive(),
		updated_at: BrowserTimestampSchema,
	})
	.strict();

const BrowserWorkTreeTicketSchema = BrowserWorkTicketSchema;

export const BrowserWorkRoleSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		name: z.string().min(1).max(128),
		scope: z.enum(["project", "session", "generation"]),
		revision: z.number().int().positive(),
		updated_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkGateSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		gate_kind: z.enum(["approval", "input"]),
		status: z.enum(["awaiting", "approved", "denied", "cancelled"]),
		question: z.string().min(1).max(4_096),
		assignee_kind: z.enum(["human", "operator"]),
		updated_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkIdeaSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		body: BrowserBodySchema,
		status: z.enum(["pending", "popped", "promoted"]),
		promoted_ticket_opaque_id: BrowserOpaqueIdSchema.optional(),
		created_at: BrowserTimestampSchema,
		updated_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkAssetMetadataSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		mime_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
		byte_size: z
			.number()
			.int()
			.positive()
			.max(10 * 1024 * 1024),
		created_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkCommentSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		parent_opaque_id: BrowserOpaqueIdSchema.optional(),
		author_kind: z.enum(["human", "session", "system"]),
		body: BrowserBodySchema,
		tag: z.string().min(1).max(64),
		status: z.string().min(1).max(64),
		revision: z.number().int().positive(),
		created_at: BrowserTimestampSchema,
		updated_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkLinkSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		target_opaque_id: BrowserOpaqueIdSchema,
		relation: z.enum(["blocks", "relates", "duplicates"]),
		created_at: BrowserTimestampSchema.optional(),
	})
	.strict();

export const BrowserWorkTrackerStreamSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		name: z.string().min(1).max(256),
		mode: z.enum(["sequential", "parallel"]),
		description: z.string().max(4_096),
		revision: z.number().int().positive(),
		updated_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkManagementOperationSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		operation_kind: z.enum(["chat", "brief", "interrupt", "halt", "control"]),
		status: BrowserOperationStatusSchema,
		created_at: BrowserTimestampSchema,
		updated_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkDispatchOperationSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		operation_kind: z.literal("dispatch"),
		subject_opaque_id: BrowserOpaqueIdSchema,
		disposition: z.enum([
			"queued",
			"pull_only",
			"next_turn",
			"ineligible",
			"stale",
		]),
		capability: z.literal("delivery").optional(),
		remediation: z
			.enum(["await_delivery", "await_next_turn", "refresh_ticket"])
			.optional(),
		settlement: z
			.enum([
				"pending",
				"delivered",
				"settled",
				"retrying",
				"failed",
				"expired",
				"cancelled",
			])
			.optional(),
		created_at: BrowserTimestampSchema,
	})
	.strict();

export const BrowserWorkOperationSchema = z.union([
	BrowserWorkManagementOperationSchema,
	BrowserWorkDispatchOperationSchema,
]);

const BrowserWorkProjectionBaseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-projection/v1"),
		resource_revision: z.number().int().nonnegative(),
		next_cursor: BrowserWorkProjectionCursorSchema.nullable(),
	})
	.strict();

export const BrowserWorkBoardProjectionSchema =
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("tracker.board"),
		items: z.array(BrowserWorkTicketSchema).max(100),
	}).strict();

export const BrowserWorkTreeProjectionSchema =
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("tracker.tree"),
		items: z.array(BrowserWorkTreeTicketSchema).max(100),
	}).strict();

export const BrowserWorkManagementProjectionSchema =
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("management.controls"),
		items: z.array(BrowserWorkManagementOperationSchema).max(100),
		roles: z.array(BrowserWorkRoleSchema).max(100),
		gates: z.array(BrowserWorkGateSchema).max(100),
		ideas: z.array(BrowserWorkIdeaSchema).max(100),
	}).strict();

export const BrowserWorkCommunicationProjectionSchema =
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("communication.operations"),
		items: z.array(BrowserWorkOperationSchema).max(100),
	}).strict();

export const BrowserWorkProjectionResponseSchema = z.discriminatedUnion(
	"stream",
	[
		BrowserWorkBoardProjectionSchema,
		BrowserWorkTreeProjectionSchema,
		BrowserWorkManagementProjectionSchema,
		BrowserWorkCommunicationProjectionSchema,
	],
);

export const BrowserWorkInvalidationSchema = z
	.object({
		kind: z.literal("invalidation"),
		category: z.enum(["tracker", "management", "communication"]),
	})
	.strict();

const BrowserWorkCursorSchema = z.string().min(1).max(512);
const BrowserWorkResyncPayloadSchema = z
	.object({
		kind: z.literal("resync_required"),
		reason: z.enum([
			"instance_changed",
			"cursor_gap",
			"cursor_compacted",
			"policy_changed",
			"protocol_mismatch",
		]),
		snapshot_url: z.string().url().max(2048),
	})
	.strict();
const BrowserWorkFrameBaseSchema = z
	.object({
		schema_version: wireVersion("browser-work-websocket-frame"),
		instance_id: ControlPlaneInstanceIdSchema,
		sequence: z.number().int().nonnegative(),
		resource_revision: z.number().int().nonnegative(),
		correlation_id: z.string().min(1).max(128),
	})
	.strict();

const BrowserWorkBoardWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
	stream: z.literal("tracker.board"),
	payload: z.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("snapshot"),
				cursor: BrowserWorkCursorSchema,
				payload: BrowserWorkBoardProjectionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal("delta"),
				cursor: BrowserWorkCursorSchema,
				delta: BrowserWorkInvalidationSchema.extend({
					category: z.literal("tracker"),
				}).strict(),
			})
			.strict(),
		BrowserWorkResyncPayloadSchema,
	]),
}).strict();

const BrowserWorkTreeWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
	stream: z.literal("tracker.tree"),
	payload: z.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("snapshot"),
				cursor: BrowserWorkCursorSchema,
				payload: BrowserWorkTreeProjectionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal("delta"),
				cursor: BrowserWorkCursorSchema,
				delta: BrowserWorkInvalidationSchema.extend({
					category: z.literal("tracker"),
				}).strict(),
			})
			.strict(),
		BrowserWorkResyncPayloadSchema,
	]),
}).strict();

const BrowserWorkManagementWebSocketFrameSchema =
	BrowserWorkFrameBaseSchema.extend({
		stream: z.literal("management.controls"),
		payload: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("snapshot"),
					cursor: BrowserWorkCursorSchema,
					payload: BrowserWorkManagementProjectionSchema,
				})
				.strict(),
			z
				.object({
					kind: z.literal("delta"),
					cursor: BrowserWorkCursorSchema,
					delta: BrowserWorkInvalidationSchema.extend({
						category: z.literal("management"),
					}).strict(),
				})
				.strict(),
			BrowserWorkResyncPayloadSchema,
		]),
	}).strict();

const BrowserWorkCommunicationWebSocketFrameSchema =
	BrowserWorkFrameBaseSchema.extend({
		stream: z.literal("communication.operations"),
		payload: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("snapshot"),
					cursor: BrowserWorkCursorSchema,
					payload: BrowserWorkCommunicationProjectionSchema,
				})
				.strict(),
			z
				.object({
					kind: z.literal("delta"),
					cursor: BrowserWorkCursorSchema,
					delta: BrowserWorkInvalidationSchema.extend({
						category: z.literal("communication"),
					}).strict(),
				})
				.strict(),
			BrowserWorkResyncPayloadSchema,
		]),
	}).strict();

export const BrowserWorkWebSocketFrameSchema = z.discriminatedUnion("stream", [
	BrowserWorkBoardWebSocketFrameSchema,
	BrowserWorkTreeWebSocketFrameSchema,
	BrowserWorkManagementWebSocketFrameSchema,
	BrowserWorkCommunicationWebSocketFrameSchema,
]);

export const BrowserWorkDetailResponseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-detail/v1"),
		item: BrowserWorkTicketSchema,
		body: BrowserBodySchema,
		comments: z.array(BrowserWorkCommentSchema).max(500),
		links: z.array(BrowserWorkLinkSchema).max(200),
		children: z.array(BrowserWorkTicketSchema).max(200),
		streams: z.array(BrowserWorkTrackerStreamSchema).max(100),
		assets: z.array(BrowserWorkAssetMetadataSchema).max(100),
	})
	.strict();

export const BrowserWorkAssetResponseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-asset/v1"),
		asset: BrowserWorkAssetMetadataSchema,
		content_base64: z.string().min(1).max(14_000_000),
	})
	.strict();

const BrowserWorkCommandBaseSchema = z.object({
	idempotency_key: z.string().min(1).max(256),
});

export const BrowserWorkCommandRequestSchema = z.discriminatedUnion("kind", [
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("ticket.create"),
		ticket_kind: BrowserTicketKindSchema.optional(),
		title: BrowserTitleSchema,
		body: BrowserBodySchema.optional(),
		priority: BrowserTicketPrioritySchema.optional(),
		labels: z.array(BrowserLabelSchema).max(32).optional(),
		parent_opaque_id: BrowserOpaqueIdSchema.optional(),
		stream_opaque_id: BrowserOpaqueIdSchema.optional(),
		wave: z.number().int().positive().max(10_000).optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("ticket.update"),
		opaque_id: BrowserOpaqueIdSchema,
		expected_revision: z.number().int().positive(),
		title: BrowserTitleSchema.optional(),
		body: BrowserBodySchema.optional(),
		priority: BrowserTicketPrioritySchema.optional(),
		labels: z.array(BrowserLabelSchema).max(32).optional(),
		parent_opaque_id: BrowserOpaqueIdSchema.optional(),
		stream_opaque_id: BrowserOpaqueIdSchema.optional(),
		wave: z.number().int().positive().max(10_000).optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("ticket.transition"),
		opaque_id: BrowserOpaqueIdSchema,
		expected_revision: z.number().int().positive(),
		phase: BrowserPhaseSchema,
		reason: z.string().min(1).max(1_024).optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("comment.create"),
		opaque_id: BrowserOpaqueIdSchema,
		parent_comment_opaque_id: BrowserOpaqueIdSchema.optional(),
		body: BrowserBodySchema.pipe(z.string().min(1)),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("link.create"),
		opaque_id: BrowserOpaqueIdSchema,
		target_opaque_id: BrowserOpaqueIdSchema,
		relation: z.enum(["blocks", "relates", "duplicates"]),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("stream.create"),
		name: z.string().min(1).max(256),
		mode: z.enum(["sequential", "parallel"]),
		description: z.string().max(4_096).optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("management.gate.create"),
		gate_kind: z.enum(["approval", "input"]),
		question: z.string().min(1).max(512),
		assignee: z.string().min(1).max(128),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("management.role.assign"),
		role_opaque_id: BrowserOpaqueIdSchema,
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("management.idea.create"),
		body: BrowserBodySchema.pipe(z.string().min(1)),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("management.idea.pop"),
		idea_opaque_id: BrowserOpaqueIdSchema,
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("management.idea.promote"),
		idea_opaque_id: BrowserOpaqueIdSchema,
		title: BrowserTitleSchema.optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("dispatch"),
		opaque_id: BrowserOpaqueIdSchema,
		expected_revision: z.number().int().positive(),
	}).strict(),
]);

export const BrowserWorkCommandResultSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("ticket"), ticket: BrowserWorkTicketSchema })
		.strict(),
	z
		.object({
			kind: z.literal("comment"),
			comment: BrowserWorkCommentSchema,
		})
		.strict(),
	z.object({ kind: z.literal("link"), link: BrowserWorkLinkSchema }).strict(),
	z
		.object({
			kind: z.literal("stream"),
			stream: BrowserWorkTrackerStreamSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("gate"),
			opaque_id: BrowserOpaqueIdSchema,
			status: z.enum(["awaiting", "approved", "denied", "cancelled"]),
			updated_at: BrowserTimestampSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("role_assignment"),
			role_opaque_id: BrowserOpaqueIdSchema,
			assigned_at: BrowserTimestampSchema,
		})
		.strict(),
	z.object({ kind: z.literal("idea"), idea: BrowserWorkIdeaSchema }).strict(),
	z
		.object({
			kind: z.literal("dispatch"),
			disposition: z.enum([
				"queued",
				"pull_only",
				"next_turn",
				"ineligible",
				"stale",
			]),
			/** The durable GOL-79 command id, never an endpoint or target id. */
			operation_id: BrowserOpaqueIdSchema,
			capability: z.enum(["delivery"]).optional(),
			remediation: z
				.enum(["await_delivery", "await_next_turn", "refresh_ticket"])
				.optional(),
		})
		.strict(),
]);

export const BrowserWorkCommandResponseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-command/v1"),
		command_id: z.string().min(1).max(128),
		status: z.enum([
			"completed",
			"rejected",
			"conflict",
			"idempotency_mismatch",
		]),
		resource_revision: z.number().int().nonnegative(),
		result: BrowserWorkCommandResultSchema,
	})
	.strict();

export const BrowserWorkErrorSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-error/v1"),
		code: z.enum([
			"browser.auth.required",
			"browser.forbidden",
			"browser.work.invalid",
			"browser.work.not_found",
			"browser-work.dispatch.unsupported",
			"tracker.revision.required",
			"tracker.conflict",
			"tracker.not_found",
			"tracker.phase.invalid",
			"tracker.input.invalid",
			"tracker.runtime_reference.invalid",
			"management.invalid",
			"management.not_found",
			"management.forbidden",
			"management.conflict",
			"management.asset_invalid",
			"command.idempotency_mismatch",
		]),
		correlation_id: z.string().min(1).max(128),
	})
	.strict();

export type BrowserWorkCommandRequest = z.infer<
	typeof BrowserWorkCommandRequestSchema
>;
export type BrowserWorkProjectionResponse = z.infer<
	typeof BrowserWorkProjectionResponseSchema
>;
export type BrowserWorkInvalidation = z.infer<
	typeof BrowserWorkInvalidationSchema
>;
export type BrowserWorkStream = z.infer<typeof BrowserWorkStreamSchema>;
export type BrowserWorkWebSocketFrame = z.infer<
	typeof BrowserWorkWebSocketFrameSchema
>;
