import fs from "node:fs";
import path from "node:path";

import { canonicalJson, sha256 } from "./hash.js";
import { createRenderManifest, lockForManifest } from "./manifest.js";
import type {
	CompileRenderOptions,
	RenderLock,
	RenderManifest,
	RenderReceipt,
} from "./types.js";

const lockName = ".golem-render-lock.json";
const swapName = ".golem-render-swap.json";

interface SwapMarker {
	readonly schemaVersion: "golem.render-swap/v1";
	readonly state: "prepared" | "prior-moved" | "stage-moved";
	readonly manifestSha256: string;
}

type LockState =
	| { readonly state: "missing" }
	| { readonly state: "valid"; readonly lock: RenderLock }
	| { readonly state: "invalid" };

function lockPath(outputDir: string): string {
	return path.join(outputDir, lockName);
}

function readLock(outputDir: string): RenderLock | undefined {
	const state = readLockState(outputDir);
	return state.state === "valid" ? state.lock : undefined;
}

function validLock(value: unknown): value is RenderLock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RenderLock>;
	return (
		candidate.schemaVersion === "golem.render-lock/v1" &&
		typeof candidate.target === "string" &&
		typeof candidate.version === "string" &&
		typeof candidate.manifestSha256 === "string" &&
		Array.isArray(candidate.files) &&
		candidate.files.every(
			(file) =>
				file &&
				typeof file.outputPath === "string" &&
				typeof file.mode === "number" &&
				typeof file.sha256 === "string" &&
				Array.isArray(file.provenance),
		)
	);
}

function readLockState(outputDir: string): LockState {
	if (!fs.existsSync(outputDir)) return { state: "missing" };
	try {
		const parsed = JSON.parse(
			fs.readFileSync(lockPath(outputDir), "utf8"),
		) as unknown;
		return validLock(parsed)
			? { state: "valid", lock: parsed }
			: { state: "invalid" };
	} catch {
		return { state: "invalid" };
	}
}

function swapPath(outputDir: string): string {
	return `${outputDir}${swapName}`;
}

function stagePath(outputDir: string): string {
	return `${outputDir}.golem-stage`;
}

function priorPath(outputDir: string): string {
	return `${outputDir}.golem-prior`;
}

function syncFile(pathname: string, contents: string): void {
	const descriptor = fs.openSync(pathname, "w", 0o600);
	try {
		fs.writeFileSync(descriptor, contents, "utf8");
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function writeMarker(outputDir: string, marker: SwapMarker): void {
	syncFile(swapPath(outputDir), canonicalJson(marker));
}

function readMarker(outputDir: string): SwapMarker | undefined {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(swapPath(outputDir), "utf8"),
		) as Partial<SwapMarker>;
		if (
			parsed.schemaVersion !== "golem.render-swap/v1" ||
			!(["prepared", "prior-moved", "stage-moved"] as const).includes(
				parsed.state as SwapMarker["state"],
			) ||
			typeof parsed.manifestSha256 !== "string"
		)
			throw new Error("render.swap_marker.invalid");
		return parsed as SwapMarker;
	} catch (error) {
		if (
			error instanceof Error &&
			(error as Error & { readonly code?: string }).code === "ENOENT"
		)
			return undefined;
		throw error;
	}
}

/**
 * Finish or reverse an interrupted sibling swap. A marker is durable before a
 * target move and is advanced only after the next move completes, so a prior
 * directory is never treated as disposable merely because it exists.
 */
function recoverSwap(outputDir: string): void {
	const marker = readMarker(outputDir);
	if (!marker) {
		if (
			fs.existsSync(priorPath(outputDir)) ||
			fs.existsSync(stagePath(outputDir))
		)
			throw new Error("render.swap_recovery.required");
		return;
	}
	const stageDir = stagePath(outputDir);
	const previousDir = priorPath(outputDir);
	const targetExists = fs.existsSync(outputDir);
	const priorExists = fs.existsSync(previousDir);
	if (marker.state === "prepared") {
		if (!targetExists || priorExists)
			throw new Error("render.swap_recovery.inconsistent");
		fs.rmSync(stageDir, { recursive: true, force: true });
		fs.rmSync(swapPath(outputDir), { force: true });
		return;
	}
	if (marker.state === "prior-moved") {
		if (!targetExists && priorExists) {
			fs.renameSync(previousDir, outputDir);
			fs.rmSync(stageDir, { recursive: true, force: true });
			fs.rmSync(swapPath(outputDir), { force: true });
			return;
		}
		if (targetExists && priorExists) {
			const current = readLock(outputDir);
			if (current?.manifestSha256 !== marker.manifestSha256)
				throw new Error("render.swap_recovery.ambiguous");
			writeMarker(outputDir, { ...marker, state: "stage-moved" });
			fs.rmSync(previousDir, { recursive: true, force: true });
			fs.rmSync(swapPath(outputDir), { force: true });
			return;
		}
		throw new Error("render.swap_recovery.inconsistent");
	}
	if (!targetExists || !priorExists)
		throw new Error("render.swap_recovery.inconsistent");
	const current = readLock(outputDir);
	if (current?.manifestSha256 !== marker.manifestSha256)
		throw new Error("render.swap_recovery.ambiguous");
	fs.rmSync(previousDir, { recursive: true, force: true });
	fs.rmSync(swapPath(outputDir), { force: true });
}

function outputPath(root: string, relativePath: string): string {
	const resolved = path.resolve(root, relativePath);
	const relative = path.relative(root, resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`render.manifest.unsafe_path:${relativePath}`);
	return resolved;
}

function outputHash(lock: RenderLock): string {
	return sha256(canonicalJson(lock.files));
}

function ensureTrailingNewline(contents: string): string {
	return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function framedBlock(contents: string, begin: string, end: string): string {
	return `${begin}\n${ensureTrailingNewline(contents)}${end}\n`;
}

function markerCount(contents: string, marker: string): number {
	return contents.split(marker).length - 1;
}

function parseManagedBlock(
	contents: string,
	markers: NonNullable<RenderLock["files"][number]["managedRegion"]>,
):
	| { readonly prefix: string; readonly inner: string; readonly suffix: string }
	| undefined {
	if (
		markerCount(contents, markers.begin) !== 1 ||
		markerCount(contents, markers.end) !== 1
	)
		return undefined;
	const beginAt = contents.indexOf(markers.begin);
	const innerStart = beginAt + markers.begin.length + 1;
	const endAt = contents.indexOf(markers.end, innerStart);
	if (endAt < innerStart) return undefined;
	const suffixAt = endAt + markers.end.length;
	return {
		prefix: contents.slice(0, beginAt),
		inner: contents.slice(innerStart, endAt),
		suffix: contents.startsWith("\n", suffixAt)
			? contents.slice(suffixAt + 1)
			: contents.slice(suffixAt),
	};
}

function tamperedFile(
	outputDir: string,
	previous: RenderLock,
): string | undefined {
	for (const file of previous.files) {
		const target = outputPath(outputDir, file.outputPath);
		try {
			const contents = fs.readFileSync(target, "utf8");
			if (file.managedRegion) {
				const parsed = parseManagedBlock(contents, file.managedRegion);
				if (
					!parsed ||
					sha256(
						framedBlock(
							parsed.inner,
							file.managedRegion.begin,
							file.managedRegion.end,
						),
					) !== file.sha256
				)
					return file.outputPath;
			} else if (sha256(contents) !== file.sha256) return file.outputPath;
		} catch {
			return file.outputPath;
		}
	}
	return undefined;
}

function writeStage(
	stageDir: string,
	lock: RenderLock,
	manifest: RenderManifest,
	previousOutputDir: string,
	previous: RenderLock | undefined,
): void {
	if (fs.existsSync(previousOutputDir))
		fs.cpSync(previousOutputDir, stageDir, { recursive: true });
	else fs.mkdirSync(stageDir, { recursive: true });
	const nextPaths = new Set(lock.files.map((file) => file.outputPath));
	for (const prior of previous?.files ?? []) {
		if (nextPaths.has(prior.outputPath)) continue;
		const target = outputPath(stageDir, prior.outputPath);
		if (!fs.existsSync(target)) continue;
		if (!prior.managedRegion) {
			fs.rmSync(target, { force: true });
			continue;
		}
		const contents = fs.readFileSync(target, "utf8");
		const parsed = parseManagedBlock(contents, prior.managedRegion);
		if (!parsed)
			throw new Error(`render.managed_region.invalid:${prior.outputPath}`);
		const survivor = `${parsed.prefix}${parsed.suffix}`;
		if (survivor) fs.writeFileSync(target, survivor, "utf8");
		else fs.rmSync(target, { force: true });
	}
	for (const source of manifest.sources) {
		const target = outputPath(stageDir, source.outputPath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		let contents = source.contents;
		if (source.managedRegion) {
			try {
				const previous = fs.readFileSync(
					outputPath(stageDir, source.outputPath),
					"utf8",
				);
				const parsed = parseManagedBlock(previous, source.managedRegion);
				if (!parsed)
					throw new Error(`render.managed_region.invalid:${source.outputPath}`);
				contents = `${parsed.prefix}${framedBlock(
					source.contents,
					source.managedRegion.begin,
					source.managedRegion.end,
				)}${parsed.suffix}`;
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.startsWith("render.managed_region")
				)
					throw error;
				contents = framedBlock(
					source.contents,
					source.managedRegion.begin,
					source.managedRegion.end,
				);
			}
		}
		fs.writeFileSync(target, contents, "utf8");
		fs.chmodSync(target, source.mode ?? 0o644);
	}
	fs.writeFileSync(lockPath(stageDir), canonicalJson(lock), "utf8");
}

/**
 * Compile one typed manifest through a sibling staging directory, then atomically
 * swap it into place. A prior target is never replaced after tamper refusal or a
 * staged failure. There is deliberately no wall-clock field in the output.
 */
export function compileRender(
	input: RenderManifest,
	options: CompileRenderOptions,
): RenderReceipt {
	const manifest = createRenderManifest(input);
	const lock = lockForManifest(manifest);
	recoverSwap(options.outputDir);
	const priorState = readLockState(options.outputDir);
	if (priorState.state === "invalid" && !options.force) {
		return {
			status: "refused",
			target: manifest.target,
			manifestSha256: lock.manifestSha256,
			outputSha256: "",
			written: [],
			rollback: "not-needed",
			refusal: { code: "render.invalid_lock", outputPath: lockName },
		};
	}
	if (
		priorState.state === "missing" &&
		fs.existsSync(options.outputDir) &&
		!options.force
	) {
		return {
			status: "refused",
			target: manifest.target,
			manifestSha256: lock.manifestSha256,
			outputSha256: "",
			written: [],
			rollback: "not-needed",
			refusal: { code: "render.unmanaged_target", outputPath: lockName },
		};
	}
	const previous = priorState.state === "valid" ? priorState.lock : undefined;
	const previousTamper = previous
		? tamperedFile(options.outputDir, previous)
		: undefined;
	if (previousTamper && !options.force) {
		return {
			status: "refused",
			target: manifest.target,
			manifestSha256: lock.manifestSha256,
			outputSha256: previous ? outputHash(previous) : "",
			written: [],
			rollback: "not-needed",
			refusal: { code: "render.tampered", outputPath: previousTamper },
		};
	}

	const stageDir = stagePath(options.outputDir);
	const previousDir = priorPath(options.outputDir);
	try {
		writeStage(stageDir, lock, manifest, options.outputDir, previous);
		writeMarker(options.outputDir, {
			schemaVersion: "golem.render-swap/v1",
			state: "prepared",
			manifestSha256: lock.manifestSha256,
		});
		const hadPreviousTarget = fs.existsSync(options.outputDir);
		if (hadPreviousTarget) {
			fs.renameSync(options.outputDir, previousDir);
			writeMarker(options.outputDir, {
				schemaVersion: "golem.render-swap/v1",
				state: "prior-moved",
				manifestSha256: lock.manifestSha256,
			});
		}
		if (options.failBeforeSwap) throw new Error("render.staged_failure");
		try {
			fs.renameSync(stageDir, options.outputDir);
			writeMarker(options.outputDir, {
				schemaVersion: "golem.render-swap/v1",
				state: "stage-moved",
				manifestSha256: lock.manifestSha256,
			});
			fs.rmSync(previousDir, { recursive: true, force: true });
			fs.rmSync(swapPath(options.outputDir), { force: true });
		} catch (error) {
			if (hadPreviousTarget && fs.existsSync(previousDir))
				fs.renameSync(previousDir, options.outputDir);
			throw error;
		}
		return {
			status: "rendered",
			target: manifest.target,
			manifestSha256: lock.manifestSha256,
			outputSha256: outputHash(lock),
			written: lock.files.map((file) => file.outputPath),
			rollback: "not-needed",
		};
	} catch (error) {
		try {
			recoverSwap(options.outputDir);
		} catch {
			// Keep the marker and both trees for the next deterministic recovery.
		}
		throw Object.assign(
			error instanceof Error ? error : new Error(String(error)),
			{
				rollback: "preserved-prior-target" as const,
			},
		);
	}
}

export function inspectRender(outputDir: string): RenderLock | undefined {
	return readLock(outputDir);
}
