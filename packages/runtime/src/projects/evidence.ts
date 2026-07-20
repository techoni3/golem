import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectIdSchema } from "@golem/contracts";

import type { ProjectDiscoveryEvidence } from "./types.js";

function git(cwd: string, args: readonly string[]): string | undefined {
	try {
		return (
			execFileSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

function safeRealpath(input: string): string | undefined {
	try {
		return fs.realpathSync(input);
	} catch {
		return undefined;
	}
}

function markerAt(
	root: string,
): { path: string; projectId?: string; name?: string } | undefined {
	const markerPath = path.join(root, ".golem-project");
	if (!fs.existsSync(markerPath)) return undefined;
	try {
		const text = fs.readFileSync(markerPath, "utf8").trim();
		if (!text) return { path: markerPath };
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { path: markerPath };
		const record = parsed as Record<string, unknown>;
		const projectId =
			typeof record.project_id === "string" &&
			ProjectIdSchema.safeParse(record.project_id).success
				? record.project_id
				: undefined;
		const name =
			typeof record.name === "string" && record.name.trim()
				? record.name.trim()
				: undefined;
		return {
			path: markerPath,
			...(projectId ? { projectId } : {}),
			...(name ? { name } : {}),
		};
	} catch {
		return { path: markerPath };
	}
}

function markerForPath(input: string):
	| {
			root: string;
			marker: { path: string; projectId?: string; name?: string };
	  }
	| undefined {
	let current = input;
	for (;;) {
		const marker = markerAt(current);
		if (marker) return { root: current, marker };
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function projectIdForPath(): string {
	return `prj_${crypto.randomUUID()}`;
}

export function locationIdForPath(): string {
	return `loc_${crypto.randomUUID()}`;
}

export function eventIdForPath(canonicalPath: string, suffix: string): string {
	const digest = crypto
		.createHash("sha256")
		.update(`${suffix}:${canonicalPath}`)
		.digest("hex");
	const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
	return `evt_${uuid}`;
}

export function discoverProjectEvidence(cwd: string): ProjectDiscoveryEvidence {
	const inputPath = path.resolve(cwd);
	const canonicalInput = safeRealpath(inputPath);
	if (!canonicalInput)
		return Object.freeze({ inputPath, source: "none" as const });
	const gitRoot = git(canonicalInput, ["rev-parse", "--show-toplevel"]);
	if (gitRoot) {
		const projectRoot = safeRealpath(gitRoot) ?? path.resolve(gitRoot);
		const gitDirRaw = git(canonicalInput, ["rev-parse", "--git-dir"]);
		const commonDirRaw = git(canonicalInput, ["rev-parse", "--git-common-dir"]);
		const gitDir = gitDirRaw
			? (safeRealpath(path.resolve(canonicalInput, gitDirRaw)) ??
				path.resolve(canonicalInput, gitDirRaw))
			: undefined;
		const gitCommonDir = commonDirRaw
			? (safeRealpath(path.resolve(canonicalInput, commonDirRaw)) ??
				path.resolve(canonicalInput, commonDirRaw))
			: undefined;
		const isWorktree = Boolean(
			gitDir && gitCommonDir && gitDir !== gitCommonDir,
		);
		return Object.freeze({
			inputPath,
			canonicalPath: projectRoot,
			projectRoot,
			...(gitCommonDir
				? { gitCommonDir, identityKey: `git-common:${gitCommonDir}` }
				: {}),
			source: "git" as const,
			relation: isWorktree ? "worktree" : "main",
			...(isWorktree === undefined ? {} : { isWorktree }),
		});
	}
	const markerResult = markerForPath(canonicalInput);
	if (markerResult)
		return Object.freeze({
			inputPath,
			canonicalPath: markerResult.root,
			projectRoot: markerResult.root,
			source: "marker" as const,
			relation: "registered" as const,
			markerPath: markerResult.marker.path,
			...(markerResult.marker.projectId
				? { markerProjectId: markerResult.marker.projectId }
				: {}),
		});
	return Object.freeze({
		inputPath,
		canonicalPath: canonicalInput,
		source: "none" as const,
	});
}

export function markerProjectName(canonicalPath: string): string | undefined {
	return markerAt(canonicalPath)?.name;
}

export function rejectBroadRoot(
	canonicalPath: string,
	options: { golemHome?: string; homeDirectory?: string } = {},
): void {
	const root = path.parse(canonicalPath).root;
	const home = options.homeDirectory
		? safeRealpath(options.homeDirectory)
		: safeRealpath(os.homedir());
	const golemHome = options.golemHome
		? safeRealpath(options.golemHome)
		: undefined;
	if (
		canonicalPath === root ||
		canonicalPath === home ||
		canonicalPath === golemHome
	)
		throw new Error("runtime.project.broad_root_rejected");
}
