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

function lockPath(outputDir: string): string {
	return path.join(outputDir, lockName);
}

function readLock(outputDir: string): RenderLock | undefined {
	try {
		return JSON.parse(
			fs.readFileSync(lockPath(outputDir), "utf8"),
		) as RenderLock;
	} catch {
		return undefined;
	}
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
				if (!parsed || sha256(parsed.inner) !== file.sha256)
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
): void {
	for (const source of manifest.sources) {
		const target = outputPath(stageDir, source.outputPath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		let contents = source.contents;
		if (source.managedRegion) {
			try {
				const previous = fs.readFileSync(
					outputPath(previousOutputDir, source.outputPath),
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
	const previous = readLock(options.outputDir);
	const previousTamper = previous
		? tamperedFile(options.outputDir, previous)
		: undefined;
	if (previousTamper) {
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

	const stageDir = `${options.outputDir}.golem-stage`;
	const previousDir = `${options.outputDir}.golem-prior`;
	fs.rmSync(stageDir, { recursive: true, force: true });
	fs.rmSync(previousDir, { recursive: true, force: true });
	try {
		writeStage(stageDir, lock, manifest, options.outputDir);
		if (options.failBeforeSwap) throw new Error("render.staged_failure");
		const hadPreviousTarget = fs.existsSync(options.outputDir);
		if (hadPreviousTarget) fs.renameSync(options.outputDir, previousDir);
		try {
			fs.renameSync(stageDir, options.outputDir);
			fs.rmSync(previousDir, { recursive: true, force: true });
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
		fs.rmSync(stageDir, { recursive: true, force: true });
		if (fs.existsSync(previousDir) && !fs.existsSync(options.outputDir))
			fs.renameSync(previousDir, options.outputDir);
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
