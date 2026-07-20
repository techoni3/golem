import { planLegacyMigration, stableAuditPlanJson } from "../plan/plan.js";
import type { AuditPlan } from "../plan/types.js";
import { readLegacyHome } from "../readers/safe-reader.js";

export async function auditLegacyHome(
	home: string,
	options: { readonly planner_version?: string } = {},
): Promise<AuditPlan> {
	return planLegacyMigration(await readLegacyHome(home), options);
}

export { stableAuditPlanJson };

export function formatAuditPlanText(plan: AuditPlan): string {
	const counts = Object.entries(plan.counts_by_reason)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([reason, count]) => `  ${reason}: ${count}`)
		.join("\n");
	return `${[
		"golem migration audit (dry-run)",
		`plan: ${plan.plan_id}`,
		`hash: ${plan.plan_hash}`,
		`source manifest: ${plan.source_manifest_hash}`,
		`actions: ${plan.actions.length}; findings: ${plan.findings.length}`,
		`backup: ${plan.requirements.backup.estimated_source_bytes} source bytes; minimum free: ${plan.requirements.disk.minimum_free_bytes}`,
		counts ? `reasons:\n${counts}` : "reasons: none",
		"No source files, databases, render targets, or configuration were modified.",
		"Apply/import is intentionally unavailable in this wave.",
	].join("\n")}\n`;
}
