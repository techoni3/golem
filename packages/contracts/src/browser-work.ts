import { z } from "zod";

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
		state: BrowserTicketStateSchema,
		phase: z.string().min(1).max(64),
		priority: BrowserTicketPrioritySchema.nullable(),
		revision: z.number().int().positive(),
		updated_at: BrowserTimestampSchema,
	})
	.strict();

const BrowserWorkTreeTicketSchema = BrowserWorkTicketSchema.extend({
	parent_opaque_id: BrowserOpaqueIdSchema.optional(),
}).strict();

export const BrowserWorkOperationSchema = z
	.object({
		opaque_id: BrowserOpaqueIdSchema,
		operation_kind: z.enum(["chat", "brief", "interrupt", "halt", "control"]),
		status: BrowserOperationStatusSchema,
		created_at: BrowserTimestampSchema,
		updated_at: BrowserTimestampSchema,
	})
	.strict();

const BrowserWorkProjectionBaseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-projection/v1"),
		resource_revision: z.number().int().nonnegative(),
		next_cursor: BrowserWorkProjectionCursorSchema.nullable(),
	})
	.strict();

export const BrowserWorkProjectionResponseSchema = z.discriminatedUnion("stream", [
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("tracker.board"),
		items: z.array(BrowserWorkTicketSchema).max(100),
	}).strict(),
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("tracker.tree"),
		items: z.array(BrowserWorkTreeTicketSchema).max(100),
	}).strict(),
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("management.controls"),
		items: z.array(BrowserWorkOperationSchema).max(100),
	}).strict(),
	BrowserWorkProjectionBaseSchema.extend({
		stream: z.literal("communication.operations"),
		items: z.array(BrowserWorkOperationSchema).max(100),
	}).strict(),
]);

export const BrowserWorkDetailResponseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-detail/v1"),
		item: BrowserWorkTicketSchema,
	})
	.strict();

export const BrowserWorkAssetResponseSchema = z
	.object({
		schema_version: z.literal("golem.browser-work-asset/v1"),
		asset: z
			.object({
				opaque_id: BrowserOpaqueIdSchema,
				mime_type: z.enum([
					"image/png",
					"image/jpeg",
					"image/gif",
					"image/webp",
				]),
				byte_size: z.number().int().positive().max(10 * 1024 * 1024),
				created_at: BrowserTimestampSchema,
			})
			.strict(),
		content_base64: z.string().min(1).max(14_000_000),
	})
	.strict();

const BrowserWorkCommandBaseSchema = z
	.object({
		idempotency_key: z.string().min(1).max(256),
	});

export const BrowserWorkCommandRequestSchema = z.discriminatedUnion("kind", [
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("ticket.create"),
		ticket_kind: BrowserTicketKindSchema.optional(),
		title: z.string().min(1).max(256),
		priority: BrowserTicketPrioritySchema.optional(),
		labels: z.array(z.string().min(1).max(64)).max(32).optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("ticket.update"),
		opaque_id: BrowserOpaqueIdSchema,
		expected_revision: z.number().int().positive(),
		title: z.string().min(1).max(256).optional(),
		priority: BrowserTicketPrioritySchema.optional(),
		labels: z.array(z.string().min(1).max(64)).max(32).optional(),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("ticket.transition"),
		opaque_id: BrowserOpaqueIdSchema,
		expected_revision: z.number().int().positive(),
		phase: z.enum([
			"queued",
			"building",
			"blocked",
			"built",
			"verifying",
			"verified",
			"rejected",
			"done",
		]),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("management.gate.create"),
		gate_kind: z.enum(["approval", "input"]),
		question: z.string().min(1).max(512),
		assignee: z.string().min(1).max(128),
	}).strict(),
	BrowserWorkCommandBaseSchema.extend({
		kind: z.literal("dispatch"),
	}).strict(),
]);

export const BrowserWorkCommandResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ticket"), ticket: BrowserWorkTicketSchema }).strict(),
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
			kind: z.literal("unsupported"),
			code: z.literal("browser-work.dispatch.unsupported"),
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
