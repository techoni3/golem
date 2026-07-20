import { z } from "zod";

import { MigrationPlanIdSchema } from "./ids.js";
import { JsonObjectSchema } from "./json.js";
import { wireVersion } from "./version.js";

export const MigrationPlanV1Schema = z
	.object({
		schema_version: wireVersion("migration-plan"),
		plan_id: MigrationPlanIdSchema,
		mode: z.enum(["dry_run", "apply", "rollback"]),
		snapshot_id: z.string().min(1).max(256),
		plan_hash: z
			.string()
			.regex(/^[a-f0-9]{64}$/u, "migration.plan_hash.invalid"),
		created_at: z.iso.datetime({ offset: true }),
		counts_by_reason: z.record(
			z.string().min(1),
			z.number().int().nonnegative(),
		),
		steps: z
			.array(
				z
					.object({
						id: z.string().min(1).max(128),
						kind: z.enum([
							"import",
							"export",
							"switch_writer",
							"validate",
							"rollback",
						]),
						input: JsonObjectSchema,
					})
					.strict(),
			)
			.min(1),
		rollback_prerequisites: z.array(z.string().min(1).max(256)),
	})
	.strict();

export type MigrationPlanV1 = z.infer<typeof MigrationPlanV1Schema>;
