import { canonicalJson, sha256 } from "./hash.js";
import type {
	LegacyRenderItem,
	RenderFileRecord,
	RenderLock,
	RenderManifest,
	RenderSource,
	RenderTarget,
} from "./types.js";

function normalizedPath(value: string): string {
	const normalized = value.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		normalized.split("/").includes("..")
	)
		throw new Error(`render.manifest.unsafe_path:${value}`);
	return normalized;
}

function normalizeSource(source: RenderSource): RenderSource {
	return {
		outputPath: normalizedPath(source.outputPath),
		contents: source.contents,
		mode: source.mode ?? 0o644,
		provenance: [...source.provenance].sort(),
		...(source.managedRegion
			? {
					managedRegion: {
						begin: source.managedRegion.begin,
						end: source.managedRegion.end,
					},
				}
			: {}),
	};
}

function renderedContents(source: RenderSource): string {
	return source.managedRegion && !source.contents.endsWith("\n")
		? `${source.contents}\n`
		: source.contents;
}

export function createRenderManifest(input: RenderManifest): RenderManifest {
	const seen = new Set<string>();
	const sources = input.sources
		.map(normalizeSource)
		.sort((left, right) => left.outputPath.localeCompare(right.outputPath));
	for (const source of sources) {
		if (seen.has(source.outputPath))
			throw new Error(`render.manifest.duplicate_path:${source.outputPath}`);
		seen.add(source.outputPath);
	}
	return Object.freeze({
		schemaVersion: "golem.render-manifest/v1",
		target: input.target,
		sourceRoot: input.sourceRoot,
		version: input.version,
		sources: Object.freeze(sources),
	});
}

export function manifestSha256(manifest: RenderManifest): string {
	return sha256(
		canonicalJson({
			schemaVersion: manifest.schemaVersion,
			target: manifest.target,
			version: manifest.version,
			sources: manifest.sources.map((source) => ({
				outputPath: source.outputPath,
				contentsSha256: sha256(renderedContents(source)),
				mode: source.mode ?? 0o644,
				provenance: source.provenance,
				managedRegion: source.managedRegion,
			})),
		}),
	);
}

export function lockForManifest(manifest: RenderManifest): RenderLock {
	const files: RenderFileRecord[] = manifest.sources.map((source) => ({
		outputPath: source.outputPath,
		mode: source.mode ?? 0o644,
		sha256: sha256(renderedContents(source)),
		provenance: source.provenance,
		...(source.managedRegion ? { managedRegion: source.managedRegion } : {}),
	}));
	return {
		schemaVersion: "golem.render-lock/v1",
		target: manifest.target,
		version: manifest.version,
		manifestSha256: manifestSha256(manifest),
		files,
	};
}

export function manifestFromLegacyPlan(input: {
	readonly target: RenderTarget;
	readonly sourceRoot: string;
	readonly version: string;
	readonly items: readonly LegacyRenderItem[];
}): RenderManifest {
	return createRenderManifest({
		schemaVersion: "golem.render-manifest/v1",
		target: input.target,
		sourceRoot: input.sourceRoot,
		version: input.version,
		sources: input.items.map((item) => {
			const built = item.build();
			return {
				outputPath: item.outputRelPath,
				contents:
					typeof built === "string" ? built : new TextDecoder().decode(built),
				...(item.mode !== undefined ? { mode: item.mode } : {}),
				provenance: [item.key, item.sourceSha256],
				...(item.type === "block" && item.beginMarker && item.endMarker
					? {
							managedRegion: {
								begin: item.beginMarker,
								end: item.endMarker,
							},
						}
					: {}),
			};
		}),
	});
}
