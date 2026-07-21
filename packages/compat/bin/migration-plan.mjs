#!/usr/bin/env node
import {
	applyLegacyMigration,
	auditLegacyHome,
	formatAuditPlanText,
	migrationStatus,
	redactDiagnosticText,
	rollbackLegacyMigration,
	stableAuditPlanJson,
} from "@golem/compat";

const rawArgs = process.argv.slice(2);
const command = ["plan", "apply", "status", "rollback"].includes(rawArgs[0])
	? rawArgs[0]
	: "plan";
const args = command === rawArgs[0] ? rawArgs.slice(1) : rawArgs;
const homeIndex = args.indexOf("--home");
const home = homeIndex === -1 ? undefined : args[homeIndex + 1];
const hashIndex = args.indexOf("--plan-hash");
const planHash = hashIndex === -1 ? undefined : args[hashIndex + 1];
const json = args.includes("--json");
const known = new Set([
	"--home",
	home,
	"--plan-hash",
	planHash,
	"--json",
	"--dry-run",
]);

if (
	!home ||
	args.some((argument) => !known.has(argument)) ||
	(command === "apply" && !planHash)
) {
	process.stderr.write(
		"Usage: golem migrate <plan|apply|status|rollback> --home <GOLEM_HOME> [--plan-hash <sha256>] [--json]\nApply requires the exact plan hash printed by `golem migrate plan`; legacy sources remain read-only.\n",
	);
	process.exitCode = 2;
} else {
	try {
		if (command === "plan") {
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
