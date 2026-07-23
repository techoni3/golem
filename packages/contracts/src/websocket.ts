import { z } from "zod";

import { ControlPlaneInstanceIdSchema } from "./ids.js";
import { JsonValueSchema } from "./json.js";
import { wireVersion } from "./version.js";

const WebSocketFramePayloadSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("snapshot"),
			cursor: z.string().min(1).max(512),
			payload: JsonValueSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("delta"),
			cursor: z.string().min(1).max(512),
			delta: JsonValueSchema,
		})
		.strict(),
	z
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
		.strict(),
]);

export const WebSocketFrameV1Schema = z
	.object({
		schema_version: wireVersion("websocket-frame"),
		instance_id: ControlPlaneInstanceIdSchema,
		stream: z.enum([
			"runtime.live",
			"runtime.history",
			"runtime.diagnostics",
			"projects",
			"tracker.tree",
			"tracker.board",
			"management.controls",
			"communication.operations",
		]),
		sequence: z.number().int().nonnegative(),
		resource_revision: z.number().int().nonnegative(),
		correlation_id: z.string().min(1).max(128),
		payload: WebSocketFramePayloadSchema,
	})
	.strict();

export type WebSocketFrameV1 = z.infer<typeof WebSocketFrameV1Schema>;
