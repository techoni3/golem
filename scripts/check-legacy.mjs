import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli", "golem.js");
const temporaryRoot = fs.mkdtempSync(
	path.join(os.tmpdir(), "golem-legacy-check-"),
);
const home = path.join(temporaryRoot, "home");
const golemHome = path.join(temporaryRoot, "state");
const xdgConfigHome = path.join(temporaryRoot, "xdg");
const environment = {
	...process.env,
	GOLEM_HOME: golemHome,
	GOLEM_SUBSTRATE_ROOT: path.join(root, "substrate"),
	HOME: home,
	XDG_CONFIG_HOME: xdgConfigHome,
};

const run = (args) => {
	try {
		return execFileSync(process.execPath, args, {
			cwd: root,
			encoding: "utf8",
			env: environment,
		});
	} catch (error) {
		if (error.stdout) process.stdout.write(error.stdout);
		if (error.stderr) process.stderr.write(error.stderr);
		throw error;
	}
};

try {
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(golemHome, { recursive: true });
	fs.mkdirSync(xdgConfigHome, { recursive: true });
	fs.writeFileSync(
		path.join(golemHome, "config.json"),
		`${JSON.stringify({ harnesses: { opencode: { enabled: true } } }, null, 2)}\n`,
	);

	run(["--check", cli]);
	for (const target of ["cc", "cc-marketplace", "codex", "opencode", "pi"]) {
		run([cli, "sync", "--target", target]);
	}
	const output = run([cli, "sync", "--check", "--all"]);
	process.stdout.write(output);
	process.stdout.write(
		"legacy check PASS: all global renders are clean in an isolated home\n",
	);
} finally {
	fs.rmSync(temporaryRoot, { force: true, recursive: true });
}
