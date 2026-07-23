#!/usr/bin/env node
import {
	applyLegacyMigration,
	applyCanonicalCutover,
	auditLegacyHome,
	canonicalCutoverStatus,
	evaluateCanonicalCutoverSoak,
	formatAuditPlanText,
	migrationStatus,
	planCanonicalCutover,
	redactDiagnosticText,
	rollbackCanonicalCutover,
	rollbackLegacyMigration,
	stableAuditPlanJson,
} from "@golem/compat";

const rawArgs = process.argv.slice(2);
const commands = [
	"plan",
	"apply",
	"status",
	"rollback",
	"cutover-plan",
	"cutover-apply",
	"cutover-status",
	"cutover-soak",
	"cutover-rollback",
];
const command = commands.includes(rawArgs[0])
	? rawArgs[0]
	: "plan";
const args = command === rawArgs[0] ? rawArgs.slice(1) : rawArgs;
const homeIndex = args.indexOf("--home");
const home = homeIndex === -1 ? undefined : args[homeIndex + 1];
const hashIndex = args.indexOf("--plan-hash");
const planHash = hashIndex === -1 ? undefined : args[hashIndex + 1];
const backlogIndex = args.indexOf("--unsafe-backlog");
const unsafeBacklog =
	backlogIndex === -1 ? undefined : Number(args[backlogIndex + 1]);
const json = args.includes("--json");
const known = new Set([
	"--home",
	home,
	"--plan-hash",
	planHash,
	"--json",
	"--dry-run",
	"--health-failed",
	"--parity-failed",
	"--owner-conflict",
	"--no-auto-rollback",
	"--unsafe-backlog",
	backlogIndex === -1 ? undefined : args[backlogIndex + 1],
]);

if (
	!home ||
	args.some((argument) => !known.has(argument)) ||
	((command === "apply" || command === "cutover-apply") && !planHash) ||
	(unsafeBacklog !== undefined &&
		(!Number.isInteger(unsafeBacklog) || unsafeBacklog < 0))
) {
	process.stderr.write(
		"Usage: golem migrate <plan|apply|status|rollback|cutover-plan|cutover-apply|cutover-status|cutover-soak|cutover-rollback> --home <GOLEM_HOME> [--plan-hash <sha256>] [--json]\nApply commands require the exact plan hash printed by their dry-run; legacy sources remain read-only.\n",
	);
	process.exitCode = 2;
} else {
	try {
		if (command === "cutover-plan") {
			const plan = await planCanonicalCutover({ home });
			process.stdout.write(
				json
					? `${JSON.stringify(plan, null, 2)}\n`
					: `${plan.eligible ? "eligible" : "blocked"}: ${plan.plan_hash}\n${plan.gates
							.map(
								(gate) =>
									`${gate.passed ? "PASS" : "FAIL"} ${gate.code}: ${gate.actual}${gate.passed ? "" : ` — ${gate.remedy}`}`,
							)
							.join("\n")}\n`,
			);
		} else if (command === "cutover-status") {
			const status = canonicalCutoverStatus(home);
			process.stdout.write(
				json
					? `${JSON.stringify(status ?? null, null, 2)}\n`
					: status
						? `${status.phase}: ${status.plan_hash}\n`
						: "no canonical cutover has started\n",
			);
		} else if (command === "cutover-rollback") {
			const result = await rollbackCanonicalCutover(home);
			process.stdout.write(
				json
					? `${JSON.stringify(result, null, 2)}\n`
					: `rolled_back: ${result.state.plan_hash}\naudit: ${result.state.rollback_audit}\n`,
			);
		} else if (command === "cutover-soak") {
			const result = await evaluateCanonicalCutoverSoak(
				home,
				{
					...(args.includes("--health-failed")
						? { health_ok: false }
						: {}),
					...(args.includes("--parity-failed")
						? { parity_ok: false }
						: {}),
					...(args.includes("--owner-conflict")
						? { single_owner: false }
						: {}),
					...(unsafeBacklog === undefined
						? {}
						: { unsafe_backlog: unsafeBacklog }),
				},
				{ auto_rollback: !args.includes("--no-auto-rollback") },
			);
			process.stdout.write(
				json
					? `${JSON.stringify(result, null, 2)}\n`
					: `${result.state.phase}: ${result.state.plan_hash}${result.triggers.length ? `\ntriggers: ${result.triggers.join(", ")}` : ""}\n`,
			);
		} else if (command === "cutover-apply") {
			const result = await applyCanonicalCutover({
				home,
				expected_plan_hash: planHash,
			});
			process.stdout.write(
				json
					? `${JSON.stringify(result, null, 2)}\n`
					: `${result.state.phase}: ${result.plan.plan_hash}\nauthority: ${result.authority.stage}/${result.authority.write_policy}\n`,
			);
		} else if (command === "plan") {
			const plan = await auditLegacyHome(home);
			process.stdout.write(
				json ? stableAuditPlanJson(plan) : formatAuditPlanText(plan),
			);
		} else if (command === "status") {
			const status = await migrationStatus(home);
			process.stdout.write(
				json
					? `${JSON.stringify(status ?? null, null, 2)}\n`
					: status
						? `${status.status}: ${status.plan_hash}\nrollback: ${status.rollback_command}\n`
						: "no migration has been applied\n",
			);
		} else if (command === "rollback") {
			const status = await rollbackLegacyMigration(home);
			process.stdout.write(
				json
					? `${JSON.stringify(status, null, 2)}\n`
					: `rolled_back: ${status.plan_hash}\n`,
			);
		} else {
			const result = await applyLegacyMigration({
				home,
				expected_plan_hash: planHash,
			});
			process.stdout.write(
				json
					? `${JSON.stringify(result.status, null, 2)}\n`
					: `applied: ${result.status.plan_hash}\ncompatibility: ${result.status.compatibility_projection}\nrollback: ${result.status.rollback_command}\n`,
			);
		}
	} catch (error) {
		const code =
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: "migration.failed";
		const message = redactDiagnosticText(
			error instanceof Error ? error.message : "migration command failed",
		);
		process.stderr.write(`${code}: ${message}\n`);
		process.exitCode = 3;
	}
}
