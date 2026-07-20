import fs from "node:fs";
import path from "node:path";

import { executionFailure } from "../process/errors.js";

export interface UpstreamDiscoveryInput {
	/** A bare native command name; PATH is never interpreted as shell syntax. */
	readonly commandName: string;
	/** A user-selected path is accepted only when its exact real path is trusted. */
	readonly explicitPath?: string;
	readonly trustedExplicitPaths?: readonly string[];
	readonly pathValue?: string;
	readonly pathSeparator?: string;
	readonly golemExecutable: string;
	readonly compatibilityShims: readonly string[];
}

export interface ResolvedUpstreamBinary {
	readonly path: string;
	readonly realpath: string;
	readonly source: "explicit" | "path";
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function realpathOrFailure(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch (error) {
		if (errno(error) === "ELOOP")
			throw executionFailure(
				"launcher.binary.symlink_loop",
				"The upstream executable resolves through a symlink loop.",
				["Choose a real executable outside the recursive link chain."],
			);
		throw executionFailure(
			"launcher.binary.unavailable",
			"The requested upstream executable is unavailable.",
			["Install the native harness or select a trusted executable path."],
		);
	}
}

function assertBareCommandName(commandName: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(commandName))
		throw executionFailure(
			"launcher.binary.command_invalid",
			"The upstream command name is invalid.",
			["Use a bare executable name or a separately trusted absolute path."],
		);
}

function assertCandidateTrusted(
	realpath: string,
	blocked: ReadonlySet<string>,
): void {
	if (blocked.has(realpath))
		throw executionFailure(
			"launcher.binary.recursion",
			"The upstream executable resolves to Golem or a compatibility shim.",
			["Install the native harness outside Golem's command and shim paths."],
		);
	let stats: fs.Stats;
	try {
		stats = fs.statSync(realpath);
	} catch {
		throw executionFailure(
			"launcher.binary.unavailable",
			"The requested upstream executable is unavailable.",
			["Install the native harness or select a trusted executable path."],
		);
	}
	if (!stats.isFile())
		throw executionFailure(
			"launcher.binary.invalid",
			"The upstream target is not a regular executable file.",
			[
				"Select the installed native executable, not a directory or special file.",
			],
		);
	if ((stats.mode & 0o111) === 0)
		throw executionFailure(
			"launcher.binary.not_executable",
			"The upstream target is not executable.",
			["Restore execute permission or select an installed native executable."],
		);
	if ((stats.mode & 0o002) !== 0)
		throw executionFailure(
			"launcher.binary.world_writable",
			"The upstream executable is world-writable and cannot be trusted.",
			["Install the harness with owner-controlled permissions."],
		);
}

function existingRealpaths(paths: readonly string[]): ReadonlySet<string> {
	const realpaths = new Set<string>();
	for (const candidate of paths) {
		try {
			realpaths.add(fs.realpathSync(candidate));
		} catch {
			// A missing compatibility path cannot recurse into this launch.
		}
	}
	return realpaths;
}

function trustedRealpaths(
	paths: readonly string[] | undefined,
): ReadonlySet<string> {
	const trusted = new Set<string>();
	for (const candidate of paths ?? []) {
		try {
			trusted.add(fs.realpathSync(candidate));
		} catch {
			// The explicit candidate will receive the stable diagnostic when selected.
		}
	}
	return trusted;
}

/**
 * Resolve only a regular, owner-controlled upstream executable. The first PATH
 * entry that names the command is decisive: an unsafe shadow never falls through
 * to a later binary with the same name.
 */
export function discoverUpstreamBinary(
	input: UpstreamDiscoveryInput,
): ResolvedUpstreamBinary {
	assertBareCommandName(input.commandName);
	const blocked = existingRealpaths([
		input.golemExecutable,
		...input.compatibilityShims,
	]);
	if (input.explicitPath) {
		if (!path.isAbsolute(input.explicitPath))
			throw executionFailure(
				"launcher.binary.explicit_untrusted",
				"An explicit executable path must be absolute and trusted.",
				[
					"Select an absolute path registered by trusted launcher configuration.",
				],
			);
		const realpath = realpathOrFailure(input.explicitPath);
		const trusted = trustedRealpaths(input.trustedExplicitPaths);
		if (!trusted.has(realpath))
			throw executionFailure(
				"launcher.binary.explicit_untrusted",
				"The explicit executable path is not in the trusted launcher allowlist.",
				[
					"Register the installed native executable through trusted user configuration.",
				],
			);
		assertCandidateTrusted(realpath, blocked);
		return Object.freeze({ path: realpath, realpath, source: "explicit" });
	}
	const separator = input.pathSeparator ?? path.delimiter;
	const entries = (input.pathValue ?? process.env.PATH ?? "").split(separator);
	for (const entry of entries) {
		if (!entry)
			throw executionFailure(
				"launcher.binary.path_entry_invalid",
				"PATH contains an empty entry and cannot safely select an upstream executable.",
				["Remove empty PATH entries before launching the native harness."],
			);
		const candidate = path.join(entry, input.commandName);
		if (!fs.existsSync(candidate)) continue;
		const realpath = realpathOrFailure(candidate);
		assertCandidateTrusted(realpath, blocked);
		return Object.freeze({ path: realpath, realpath, source: "path" });
	}
	throw executionFailure(
		"launcher.binary.unavailable",
		"No trusted upstream executable was found on PATH.",
		["Install the native harness or configure one trusted executable path."],
	);
}
