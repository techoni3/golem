import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface LaunchAgentDefinition {
	readonly label: string;
	readonly program: string;
	readonly arguments: readonly string[];
	readonly workingDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
}

export interface LaunchAgentInstall {
	readonly path: string;
	readonly backupPath?: string;
}

export interface LaunchctlResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface LaunchctlBoundary {
	run(arguments_: readonly string[]): LaunchctlResult;
}

export interface LaunchAgentStatus {
	readonly label: string;
	readonly target: string;
	readonly installed: boolean;
	readonly loaded: boolean;
	readonly detail: string;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function stringValue(value: string): string {
	return `<string>${escapeXml(value)}</string>`;
}

export function renderLaunchAgent(definition: LaunchAgentDefinition): string {
	if (!definition.label.startsWith("dev.golem."))
		throw new Error("LaunchAgent label must remain in the dev.golem namespace");
	for (const value of [definition.program, definition.workingDirectory]) {
		if (!path.isAbsolute(value))
			throw new Error("LaunchAgent paths must be absolute");
	}
	const argumentsXml = [definition.program, ...definition.arguments]
		.map(stringValue)
		.join("");
	const environmentXml = Object.entries(definition.environment)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `<key>${escapeXml(key)}</key>${stringValue(value)}`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key>${stringValue(definition.label)}<key>ProgramArguments</key><array>${argumentsXml}</array><key>WorkingDirectory</key>${stringValue(definition.workingDirectory)}<key>EnvironmentVariables</key><dict>${environmentXml}</dict><key>RunAtLoad</key><false/></dict></plist>\n`;
}

export function installLaunchAgent(
	directory: string,
	definition: LaunchAgentDefinition,
): LaunchAgentInstall {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const target = path.join(directory, `${definition.label}.plist`);
	fs.writeFileSync(target, renderLaunchAgent(definition), {
		encoding: "utf8",
		mode: 0o600,
	});
	return Object.freeze({ path: target });
}

export function updateLaunchAgent(
	directory: string,
	definition: LaunchAgentDefinition,
): LaunchAgentInstall {
	const target = path.join(directory, `${definition.label}.plist`);
	const backupPath = `${target}.previous`;
	if (fs.existsSync(target))
		fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_FICLONE);
	fs.writeFileSync(target, renderLaunchAgent(definition), {
		encoding: "utf8",
		mode: 0o600,
	});
	return fs.existsSync(backupPath)
		? Object.freeze({ path: target, backupPath })
		: Object.freeze({ path: target });
}

export function rollbackLaunchAgent(install: LaunchAgentInstall): void {
	if (!install.backupPath || !fs.existsSync(install.backupPath)) return;
	fs.renameSync(install.backupPath, install.path);
}

function launchctlBoundary(): LaunchctlBoundary {
	return {
		run: (arguments_) => {
			const result = spawnSync("/bin/launchctl", arguments_, {
				encoding: "utf8",
			});
			return Object.freeze({
				status: result.status ?? 1,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? result.error?.message ?? "",
			});
		},
	};
}

function launchDomain(uid: number): string {
	if (!Number.isInteger(uid) || uid < 0)
		throw new Error("LaunchAgent requires a non-negative per-user uid");
	return `gui/${uid}`;
}

function launchTarget(label: string, uid: number): string {
	if (!label.startsWith("dev.golem."))
		throw new Error("LaunchAgent label must remain in the dev.golem namespace");
	return `${launchDomain(uid)}/${label}`;
}

/** Explicit only: no install path or postinstall invokes launchctl automatically. */
export function startLaunchAgent(options: {
	readonly label: string;
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
}): LaunchctlResult {
	return (options.runner ?? launchctlBoundary()).run([
		"kickstart",
		"-k",
		launchTarget(options.label, options.uid),
	]);
}

/** Explicit only: leaves the plist in place so the caller can inspect or restart it. */
export function stopLaunchAgent(options: {
	readonly label: string;
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
}): LaunchctlResult {
	return (options.runner ?? launchctlBoundary()).run([
		"kill",
		"SIGTERM",
		launchTarget(options.label, options.uid),
	]);
}

export function statusLaunchAgent(options: {
	readonly directory: string;
	readonly label: string;
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
}): LaunchAgentStatus {
	const target = launchTarget(options.label, options.uid);
	const plist = path.join(options.directory, `${options.label}.plist`);
	const result = (options.runner ?? launchctlBoundary()).run(["print", target]);
	return Object.freeze({
		label: options.label,
		target,
		installed: fs.existsSync(plist),
		loaded: result.status === 0,
		detail: (result.stdout || result.stderr).trim(),
	});
}
