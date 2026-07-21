#!/usr/bin/env node
import { exerciseControlPlaneShell } from "../control-plane/control-plane-shell.mjs";
import { exerciseRuntimeDashboard } from "./runtime-dashboard.mjs";

const arguments_ = process.argv.slice(2);
const grepIndex = arguments_.indexOf("--grep");
const grep = grepIndex === -1 ? undefined : arguments_[grepIndex + 1];
if (!["control-plane-shell", "dashboard-shell", "runtime-dashboard"].includes(grep) || arguments_.length !== 2)
	throw new Error("use --grep control-plane-shell, dashboard-shell, or runtime-dashboard");

try {
	if (grep === "runtime-dashboard") await exerciseRuntimeDashboard();
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
