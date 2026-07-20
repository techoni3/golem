export const renderTargets = [
	"cc",
	"cc-marketplace",
	"codex",
	"opencode",
	"pi",
] as const;

export type RenderTarget = (typeof renderTargets)[number];

export interface ManagedRegion {
	readonly begin: string;
	readonly end: string;
}

export interface RenderSource {
	readonly outputPath: string;
	readonly contents: string;
	readonly mode?: number;
	readonly provenance: readonly string[];
	readonly managedRegion?: ManagedRegion;
}

export interface RenderManifest {
	readonly schemaVersion: "golem.render-manifest/v1";
	readonly target: RenderTarget;
	readonly sourceRoot: string;
	readonly version: string;
	readonly sources: readonly RenderSource[];
}

export interface RenderFileRecord {
	readonly outputPath: string;
	readonly mode: number;
	readonly sha256: string;
	readonly provenance: readonly string[];
	readonly managedRegion?: ManagedRegion;
}

export interface RenderLock {
	readonly schemaVersion: "golem.render-lock/v1";
	readonly target: RenderTarget;
	readonly version: string;
	readonly manifestSha256: string;
	readonly files: readonly RenderFileRecord[];
}

export interface RenderReceipt {
	readonly status: "rendered" | "refused";
	readonly target: RenderTarget;
	readonly manifestSha256: string;
	readonly outputSha256: string;
	readonly written: readonly string[];
	readonly rollback: "not-needed" | "preserved-prior-target";
	readonly refusal?: {
		readonly code:
			| "render.tampered"
			| "render.invalid_lock"
			| "render.unmanaged_target";
		readonly outputPath: string;
	};
}

export interface CompileRenderOptions {
	readonly outputDir: string;
	/** Explicit owner-authorized recovery from a refused managed target. */
	readonly force?: boolean;
	readonly failBeforeSwap?: boolean;
}

/** Compatibility-shaped input from the existing JavaScript adapter plans. */
export interface LegacyRenderItem {
	readonly key: string;
	readonly outputRelPath: string;
	readonly mode?: number;
	readonly sourceSha256: string;
	readonly build: () => string | Uint8Array;
	readonly type?: "block";
	readonly beginMarker?: string;
	readonly endMarker?: string;
}
