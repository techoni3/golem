import { z } from "zod";

import { EventIdSchema, ProjectIdSchema } from "./ids.js";
import { JsonObjectSchema } from "./json.js";
import { wireVersion } from "./version.js";

export const DiagnosticsExplanationV1Schema = z
	.object({
		schema_version: wireVersion("diagnostics-explanation"),
		code: z.string().min(1).max(128),
		severity: z.enum(["info", "warning", "error"]),
		message: z.string().min(1).max(1024),
		project_id: ProjectIdSchema.optional(),
		event_ids: z.array(EventIdSchema).max(64),
		facts: JsonObjectSchema,
		remediation: z.array(z.string().min(1).max(512)).max(16),
	})
	.strict();

export type DiagnosticsExplanationV1 = z.infer<
	typeof DiagnosticsExplanationV1Schema
>;
