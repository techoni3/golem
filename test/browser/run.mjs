#!/usr/bin/env node
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
const grepIndex = arguments_.indexOf("--grep");
const grep = grepIndex === -1 ? undefined : arguments_[grepIndex + 1];
if (
	![
		"control-plane-shell",
		"dashboard-shell",
		"runtime-dashboard",
		"work-control-plane",
		"work-management",
		"settings-controls",
		"accessibility-responsive-themes",
		"dashboard-state-matrix",
	].includes(grep) ||
	arguments_.length !== 2
)
	throw new Error(
		"use --grep control-plane-shell, dashboard-shell, runtime-dashboard, work-control-plane, work-management, settings-controls, accessibility-responsive-themes, or dashboard-state-matrix",
	);

try {
	if (grep === "runtime-dashboard") await exerciseRuntimeDashboard();
	else if (grep === "accessibility-responsive-themes")
		await exerciseAccessibilityResponsiveThemes();
	else if (grep === "dashboard-state-matrix")
		await exerciseDashboardStateMatrix();
	else if (grep === "work-control-plane") await exerciseWorkControlPlane();
	else if (grep === "work-management")
		await exerciseWorkManagementDashboard();
	else if (grep === "settings-controls") await exerciseSettingsControls();
	else await exerciseControlPlaneShell();
	process.stdout.write(`${grep} PASS\n`);
} catch (error) {
	if (/(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(String(error?.stack ?? error))) {
		process.stdout.write(`${grep} UNMET: sandbox rejected the real 127.0.0.1 listener (EPERM)\n`);
		process.exitCode = 2;
	} else {
		throw error;
	}
}
