#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const mode = args[args.indexOf("--mode") + 1] || "ready";
const sigtermResistant = mode === "stubborn-tree";
const logPath = process.env.TESTKIT_FAKE_LOG;
const escapePath = process.env.TESTKIT_ESCAPE_PATH;
if (!logPath) throw new Error("TESTKIT_FAKE_LOG is required");

const actualStdio = {
	stdin_is_tty: process.stdin.isTTY === true,
	stdout_is_tty: process.stdout.isTTY === true,
	stderr_is_tty: process.stderr.isTTY === true,
};

const record = (event, extra = {}) => {
	fs.appendFileSync(logPath, `${JSON.stringify({
		event,
		args,
		env: {
			TESTKIT_FAKE_VALUE: process.env.TESTKIT_FAKE_VALUE || null,
			has_upstream_secret: typeof process.env.UPSTREAM_TOKEN === "string",
			has_forbidden_inherited_value: typeof process.env.FORBIDDEN_INHERITED === "string",
		},
		...extra,
	})}\n`);
};

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => record("stdin", { stdin }));
process.once("SIGTERM", () => {
	record("signal", { signal: "SIGTERM", resisted: sigtermResistant });
	if (!sigtermResistant) process.exit(0);
});
process.once("SIGINT", () => { record("signal", { signal: "SIGINT" }); process.exit(0); });
process.on("SIGWINCH", () => record("signal", { signal: "SIGWINCH" }));

record("start", { mode, cwd: process.cwd(), stdio: actualStdio });
if (mode === "crash") {
	record("exit", { code: 23 });
	process.exit(23);
}
if (mode === "duplicate") {
	process.stdout.write("duplicate-output\nduplicate-output\n");
	process.exit(0);
}
if (mode === "escape") {
	if (!escapePath) throw new Error("TESTKIT_ESCAPE_PATH is required for escape mode");
	fs.writeFileSync(escapePath, "fixture escape attempt\n");
	record("escape", { escapePath });
	process.exit(0);
}
if (mode === "delayed") {
	setTimeout(() => { record("ready"); process.stdout.write("ready\n"); }, 80);
	setInterval(() => {}, 1_000);
} else if (mode === "tree" || mode === "stubborn-tree") {
	const worker = spawn(
		process.execPath,
		[
			"--eval",
			mode === "stubborn-tree"
				? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
				: "setInterval(() => {}, 1000)",
		],
		{ stdio: "ignore" },
	);
	// This record is emitted only after the root's SIGTERM handler above has
	// been installed and the descendant process exists. The J5 timeout arm is
	// intentionally gated on this fact, not on an elapsed startup delay.
	record("ready", {
		worker_pid: worker.pid,
		root_sigterm_resistance_ready: sigtermResistant,
	});
	process.stdout.write("ready\n");
	process.stderr.write("fixture-stderr\n");
	setInterval(() => {}, 1_000);
} else {
	record("ready");
	process.stdout.write("ready\n");
	process.stdin.resume();
}
