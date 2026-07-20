#!/usr/bin/env node
import { exerciseControlPlaneShell } from "../control-plane/control-plane-shell.mjs";

const arguments_ = process.argv.slice(2);
const grepIndex = arguments_.indexOf("--grep");
const grep = grepIndex === -1 ? undefined : arguments_[grepIndex + 1];
if (
	!["control-plane-shell", "dashboard-shell"].includes(grep) ||
	arguments_.length !== 2
)
	throw new Error("use --grep control-plane-shell or --grep dashboard-shell");

try {
	await exerciseControlPlaneShell();
	process.stdout.write(`${grep} PASS\n`);
} catch (error) {
	if (/(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(String(error?.stack ?? error))) {
		process.stdout.write(`${grep} UNMET: sandbox rejected the real 127.0.0.1 listener (EPERM)\n`);
		process.exitCode = 2;
	} else {
		throw error;
	}
}
