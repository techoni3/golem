#!/usr/bin/env node
import {
	auditLegacyHome,
	formatAuditPlanText,
	stableAuditPlanJson,
} from "@golem/compat";

const args = process.argv.slice(2);
const homeIndex = args.indexOf("--home");
const home = homeIndex === -1 ? undefined : args[homeIndex + 1];
const json = args.includes("--json");
const known = new Set(["--home", home, "--json", "--dry-run"]);

if (
	!home ||
	args.some((argument) => !known.has(argument)) ||
	args.includes("--apply") ||
	args.includes("--import")
) {
	process.stderr.write(
		"Usage: npm run migration:plan -- --home <GOLEM_HOME> [--json] [--dry-run]\nThis command is read-only; apply/import is unavailable.\n",
	);
	process.exitCode = 2;
} else {
	const plan = await auditLegacyHome(home);
	process.stdout.write(
		json ? stableAuditPlanJson(plan) : formatAuditPlanText(plan),
	);
}
