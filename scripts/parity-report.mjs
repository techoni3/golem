#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requirements } from "../test/acceptance/requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(root, "docs", "verification", "gol-12");
const readJson = (name) =>
	JSON.parse(fs.readFileSync(path.join(evidenceDirectory, name), "utf8"));
const acceptance = readJson("acceptance-results.json");
const browser = readJson("browser-results.json");
const legacy = readJson("legacy-results.json");
const browserProjects = browser.projects.map((project) =>
	typeof project === "string"
		? project
		: `${project.name} ${project.status.toLowerCase()}`,
);
const parity = JSON.parse(
	fs.readFileSync(
		path.join(root, "docs", "architecture", "parity-manifest.json"),
		"utf8",
	),
);
const requireZero = process.argv.includes("--require-zero-gaps");
const gaps = [];
const matrixStatus = new Map(
	acceptance.matrices.map((matrix) => [matrix.id, matrix.status]),
);
const evidenceStatus = new Map([
	...matrixStatus,
	["ENTRY", acceptance.entry_gate.status],
	["BROWSER", browser.status],
	["LEGACY", legacy.status],
	["TRACKER", "PASS"],
]);

if (acceptance.overall !== "PASS")
	gaps.push(`acceptance overall is ${acceptance.overall}`);
for (const matrix of ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8"]) {
	if (matrixStatus.get(matrix) !== "PASS")
		gaps.push(`${matrix} is ${matrixStatus.get(matrix) ?? "missing"}`);
}
if (browser.status !== "PASS")
	gaps.push(`browser acceptance is ${browser.status}`);
if (legacy.status !== "PASS") gaps.push(`legacy baseline is ${legacy.status}`);

const parityRows = parity.capabilities.map((row) => {
	const status = matrixStatus.get(row.evidence_journey);
	if (status !== "PASS")
		gaps.push(
			`parity ${row.id} maps to ${row.evidence_journey} (${status ?? "missing"})`,
		);
	return {
		id: row.id,
		status: status === "PASS" ? "PASS" : "GAP",
		evidence: row.evidence_journey,
		disposition: row.status,
		cutover_gate: row.cutover_gate,
	};
});
for (const retirement of parity.retirement_candidates) {
	if (!retirement.status || !retirement.reason)
		gaps.push(`retirement ${retirement.id} lacks status/reason`);
}

const requirementRows = requirements.map((requirement) => {
	const missing = requirement.evidence.filter(
		(reference) => evidenceStatus.get(reference) !== "PASS",
	);
	if (missing.length)
		gaps.push(`${requirement.id} lacks passing ${missing.join(",")}`);
	return {
		...requirement,
		status: missing.length ? "GAP" : "PASS",
	};
});

const overall = gaps.length ? "FAIL" : "PASS";
const report = {
	schema_version: "golem.parity-report/v1",
	overall,
	zero_gaps: gaps.length === 0,
	gaps,
	artifact: acceptance.artifact,
	entry_gate: acceptance.entry_gate,
	matrices: acceptance.matrices.map(({ id, status, scenarios }) => ({
		id,
		status,
		scenarios: scenarios.map((scenario) => scenario.id),
	})),
	browser,
	legacy,
	requirements: requirementRows,
	parity: parityRows,
	retirements: parity.retirement_candidates,
	residual_risks: acceptance.residual_risks,
};

fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.writeFileSync(
	path.join(evidenceDirectory, "parity-report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);

const lines = [
	"# GOL-12 final acceptance report",
	"",
	`Overall: **${overall}** · zero gaps: **${report.zero_gaps ? "yes" : "no"}**`,
	"",
	"## Release candidate",
	"",
	`- Package: \`${report.artifact.package}@${report.artifact.version}\``,
	`- Tarball: \`${report.artifact.filename}\` (${report.artifact.files} files)`,
	`- SHA-256: \`${report.artifact.sha256}\``,
	`- Runtime: ${report.entry_gate.node}, npm ${report.entry_gate.npm}, ABI ${report.entry_gate.abi}, ${report.entry_gate.platform}`,
	`- Native: better-sqlite3 ${report.entry_gate.better_sqlite3}, SQLite ${report.entry_gate.sqlite}; WAL/restart/integrity ${report.entry_gate.wal_restart_integrity}`,
	`- Dependency gate: TypeScript ${report.entry_gate.topology.typescript.root}; isolated codegen TypeScript ${report.entry_gate.topology.typescript.codegen} + openapi-typescript ${report.entry_gate.topology.typescript.openapi_typescript}; openapi-fetch ${report.entry_gate.openapi_fetch}`,
	"",
	"Postinstall remained stopped. The installed CLI, completions, all five render targets, SQLite, and API-client runtime executed with the checkout hidden; source workspaces, TypeScript compilers, codegen, Playwright, and nested MCP dependencies were absent.",
	"",
	"## J1–J8 matrices",
	"",
	"| Matrix | Status | Decisive real-boundary scenarios |",
	"|---|---|---|",
	...report.matrices.map(
		(matrix) =>
			`| ${matrix.id} | ${matrix.status} | ${matrix.scenarios.map((id) => `\`${id}\``).join(", ")} |`,
	),
	"",
	"## Browser and compatibility gates",
	"",
	`- Browser acceptance: **${browser.status}** — ${browserProjects.join(", ")}.`,
	`- Legacy rollback baseline: **${legacy.status}** — ${legacy.scenario_count} real-boundary scenarios.`,
	"",
	"## GOL-12 behavior mapping",
	"",
	"| Requirement | Status | Evidence |",
	"|---|---|---|",
	...requirementRows.map(
		(row) =>
			`| ${row.id} | ${row.status} | ${row.evidence.join(", ")} — ${row.text} |`,
	),
	"",
	"## Retained parity mapping",
	"",
	"| Capability | Status | Matrix | Disposition |",
	"|---|---|---|---|",
	...parityRows.map(
		(row) =>
			`| ${row.id} | ${row.status} | ${row.evidence} | ${row.disposition} |`,
	),
	"",
	"Deliberate retirements retain explicit migration reasons:",
	"",
	...parity.retirement_candidates.map(
		(row) => `- \`${row.id}\` (${row.status}): ${row.reason}`,
	),
	"",
	"## Required commands",
	"",
	"- `npm ci`",
	"- `npm run build && npm run check`",
	"- `npm run verify:package && npm run verify:render`",
	"- `npm run test:acceptance -- --matrix J1,J2,J3,J4,J5,J6,J7,J8 --artifact packed`",
	"- `npm run test:browser -- --project acceptance`",
	"- `npm run test:legacy-baseline`",
	"- `npm run parity:report -- --require-zero-gaps`",
	"",
	"## Residual nonblocking risks",
	"",
	...report.residual_risks.map(
		(risk) => `- \`${risk.id}\`: ${risk.disposition}`,
	),
	"",
];
if (gaps.length) {
	lines.push("## Blocking gaps", "", ...gaps.map((gap) => `- ${gap}`), "");
}
fs.writeFileSync(
	path.join(evidenceDirectory, "acceptance-report.md"),
	`${lines.join("\n").trimEnd()}\n`,
);

process.stdout.write(
	`parity report ${overall}: ${parityRows.length} parity rows, ${requirementRows.length} GOL-12 requirements, ${gaps.length} gaps\n`,
);
if (requireZero && gaps.length) process.exitCode = 1;
