import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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

export interface LaunchAgentCommandOptions {
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
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

function plistPath(directory: string, label: string): string {
	if (!label.startsWith("dev.golem."))
		throw new Error("LaunchAgent label must remain in the dev.golem namespace");
	return path.join(directory, `${label}.plist`);
}

function atomicWrite(target: string, value: string): void {
	const temporary = `${target}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, target);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// Preserve the write failure; the temporary file stays in the caller's
			// private directory and is never promoted to the plist target.
		}
		throw error;
	}
}

function isCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
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

function run(
	options: LaunchAgentCommandOptions,
	arguments_: readonly string[],
): LaunchctlResult {
	return (options.runner ?? launchctlBoundary()).run(arguments_);
}

function mustSucceed(result: LaunchctlResult, action: string): void {
	if (result.status === 0) return;
	throw new Error(
		`${action} failed: ${(result.stderr || result.stdout).trim()}`,
	);
}

export function renderLaunchAgent(definition: LaunchAgentDefinition): string {
	if (!definition.label.startsWith("dev.golem."))
		throw new Error("LaunchAgent label must remain in the dev.golem namespace");
	for (const value of [definition.program, definition.workingDirectory])
		if (!path.isAbsolute(value))
			throw new Error("LaunchAgent paths must be absolute");
	const argumentsXml = [definition.program, ...definition.arguments]
		.map(stringValue)
		.join("");
	const environmentXml = Object.entries(definition.environment)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `<key>${escapeXml(key)}</key>${stringValue(value)}`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key>${stringValue(definition.label)}<key>ProgramArguments</key><array>${argumentsXml}</array><key>WorkingDirectory</key>${stringValue(definition.workingDirectory)}<key>EnvironmentVariables</key><dict>${environmentXml}</dict><key>RunAtLoad</key><false/></dict></plist>\n`;
}

function writeDefinition(
	directory: string,
	definition: LaunchAgentDefinition,
): LaunchAgentInstall {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const target = plistPath(directory, definition.label);
	const backupPath = `${target}.previous`;
	const hadExisting = fs.existsSync(target);
	if (hadExisting)
		fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_FICLONE);
	try {
		atomicWrite(target, renderLaunchAgent(definition));
		return hadExisting
			? Object.freeze({ path: target, backupPath })
			: Object.freeze({ path: target });
	} catch (error) {
		if (hadExisting && fs.existsSync(backupPath))
			atomicWrite(target, fs.readFileSync(backupPath, "utf8"));
		throw error;
	}
}

/** Explicit installation writes atomically; optional bootstrap loads but never starts RunAtLoad=false. */
export function installLaunchAgent(
	directory: string,
	definition: LaunchAgentDefinition,
	options?: LaunchAgentCommandOptions,
): LaunchAgentInstall {
	const install = writeDefinition(directory, definition);
	if (!options) return install;
	try {
		mustSucceed(
			run(options, ["bootstrap", launchDomain(options.uid), install.path]),
			"launchctl bootstrap",
		);
		return install;
	} catch (error) {
		rollbackLaunchAgent(install);
		throw error;
	}
}

/** Explicit update preserves the prior plist and atomically reloads only when asked. */
export function updateLaunchAgent(
	directory: string,
	definition: LaunchAgentDefinition,
	options?: LaunchAgentCommandOptions,
): LaunchAgentInstall {
	const install = writeDefinition(directory, definition);
	if (!options) return install;
	try {
		run(options, ["bootout", launchTarget(definition.label, options.uid)]);
		mustSucceed(
			run(options, ["bootstrap", launchDomain(options.uid), install.path]),
			"launchctl bootstrap update",
		);
		return install;
	} catch (error) {
		rollbackLaunchAgent(install, options);
		throw error;
	}
}

export function rollbackLaunchAgent(
	install: LaunchAgentInstall,
	options?: LaunchAgentCommandOptions,
): void {
	if (install.backupPath && fs.existsSync(install.backupPath))
		atomicWrite(install.path, fs.readFileSync(install.backupPath, "utf8"));
	else {
		try {
			fs.unlinkSync(install.path);
		} catch (error) {
			if (!isCode(error, "ENOENT")) throw error;
		}
	}
	if (!options || !fs.existsSync(install.path)) return;
	const label = path.basename(install.path).replace(/\.plist$/u, "");
	run(options, ["bootout", launchTarget(label, options.uid)]);
	mustSucceed(
		run(options, ["bootstrap", launchDomain(options.uid), install.path]),
		"launchctl bootstrap rollback",
	);
}

/** Explicit only: no install path or postinstall invokes launchctl start. */
export function startLaunchAgent(options: {
	readonly label: string;
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
}): LaunchctlResult {
	return run(options, [
		"kickstart",
		"-k",
		launchTarget(options.label, options.uid),
	]);
}

/** Explicit only: leaves the plist in place so callers can inspect or restart it. */
export function stopLaunchAgent(options: {
	readonly label: string;
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
}): LaunchctlResult {
	return run(options, [
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
	const result = run(options, ["print", target]);
	return Object.freeze({
		label: options.label,
		target,
		installed: fs.existsSync(plistPath(options.directory, options.label)),
		loaded: result.status === 0,
		detail: (result.stdout || result.stderr).trim(),
	});
}
