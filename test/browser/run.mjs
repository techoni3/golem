#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exerciseControlPlaneShell } from "../control-plane/control-plane-shell.mjs";
import { exerciseAccessibilityResponsiveThemes } from "./dashboard-polish.mjs";
import {
	exerciseDashboardStateMatrix,
	exerciseRuntimeDashboard,
} from "./runtime-dashboard.mjs";
import {
	exerciseWorkControlPlane,
	exerciseWorkManagementDashboard,
	exerciseSettingsControls,
} from "./work-control-plane.mjs";

const arguments_ = process.argv.slice(2);
const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const evidencePath = path.join(
	repositoryRoot,
	"docs",
	"verification",
	"gol-12",
	"browser-results.json",
);
const exercises = new Map([
	["control-plane-shell", exerciseControlPlaneShell],
	["dashboard-shell", exerciseControlPlaneShell],
	["runtime-dashboard", exerciseRuntimeDashboard],
	["work-control-plane", exerciseWorkControlPlane],
	["work-management", exerciseWorkManagementDashboard],
	["settings-controls", exerciseSettingsControls],
	["accessibility-responsive-themes", exerciseAccessibilityResponsiveThemes],
	["dashboard-state-matrix", exerciseDashboardStateMatrix],
]);
const acceptanceProjects = [
	"accessibility-responsive-themes",
	"dashboard-state-matrix",
	"work-control-plane",
];
const listenerUnavailable = (error) =>
	/(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(
		String(error?.stack ?? error),
	);
const diagnosticFor = (error) =>
	String(error?.stack ?? error)
		.replaceAll(repositoryRoot, "<checkout>")
		.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:<port>");

const grepIndex = arguments_.indexOf("--grep");
const grep = grepIndex === -1 ? undefined : arguments_[grepIndex + 1];
const acceptanceProject =
	arguments_.length === 2 &&
	arguments_[0] === "--project" &&
	arguments_[1] === "acceptance";

if (!acceptanceProject && (!exercises.has(grep) || arguments_.length !== 2))
	throw new Error(
		"use --project acceptance or --grep control-plane-shell, dashboard-shell, runtime-dashboard, work-control-plane, work-management, settings-controls, accessibility-responsive-themes, or dashboard-state-matrix",
	);

if (acceptanceProject) {
	const projects = [];
	for (const name of acceptanceProjects) {
		try {
			await exercises.get(name)();
			projects.push({ name, status: "PASS" });
			process.stdout.write(`${name} PASS\n`);
		} catch (error) {
			const status = listenerUnavailable(error) ? "UNMET" : "FAIL";
			projects.push({ name, status, diagnostic: diagnosticFor(error) });
			process.stdout.write(`${name} ${status}\n`);
		}
	}
	const status = projects.some((project) => project.status === "FAIL")
		? "FAIL"
		: projects.some((project) => project.status === "UNMET")
			? "UNMET"
			: "PASS";
	const result = {
		schema_version: "golem.acceptance-browser/v1",
		status,
		project: "acceptance",
		headless: true,
		projects,
		accessibility_violations: {
			serious: status === "PASS" ? 0 : null,
			critical: status === "PASS" ? 0 : null,
		},
	};
	fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
	fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(
		`browser acceptance ${status}: evidence docs/verification/gol-12/browser-results.json\n`,
	);
	process.exitCode = status === "PASS" ? 0 : status === "UNMET" ? 2 : 1;
} else {
	try {
		await exercises.get(grep)();
		process.stdout.write(`${grep} PASS\n`);
	} catch (error) {
		if (listenerUnavailable(error)) {
			process.stdout.write(
				`${grep} UNMET: sandbox rejected the real 127.0.0.1 listener (EPERM)\n`,
			);
			process.exitCode = 2;
		} else {
			throw error;
		}
	}
}
