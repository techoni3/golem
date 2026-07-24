import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PersistencePaths } from "./types.js";

export const controlPlaneAuthoritySchemaVersion =
	"golem.control-plane-authority/v1" as const;

export type ControlPlaneAuthorityStage = "C3" | "C4";
export type ControlPlaneWritePolicy =
	| "legacy_open"
	| "quiesced"
	| "canonical_only";

export interface ControlPlaneAuthority {
	readonly schema_version: typeof controlPlaneAuthoritySchemaVersion;
	readonly stage: ControlPlaneAuthorityStage;
	readonly write_policy: ControlPlaneWritePolicy;
	readonly revision: number;
	readonly updated_at: string;
	readonly plan_hash?: string;
	readonly canonical_revision?: number;
	readonly rollback_audit?: string;
}

export interface ControlPlaneAuthorityUpdate {
	readonly stage: ControlPlaneAuthorityStage;
	readonly write_policy: ControlPlaneWritePolicy;
	readonly updated_at?: string;
	readonly plan_hash?: string;
	readonly canonical_revision?: number;
	readonly rollback_audit?: string;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validAuthority(value: unknown): value is ControlPlaneAuthority {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.schema_version !== controlPlaneAuthoritySchemaVersion ||
		(candidate.stage !== "C3" && candidate.stage !== "C4") ||
		(candidate.write_policy !== "legacy_open" &&
			candidate.write_policy !== "quiesced" &&
			candidate.write_policy !== "canonical_only") ||
		!Number.isInteger(candidate.revision) ||
		Number(candidate.revision) < 0 ||
		!validTimestamp(candidate.updated_at)
	)
		return false;
	if (
		(candidate.stage === "C3" && candidate.write_policy === "canonical_only") ||
		(candidate.stage === "C4" && candidate.write_policy !== "canonical_only")
	)
		return false;
	if (candidate.plan_hash !== undefined && !validHash(candidate.plan_hash))
		return false;
	if (
		candidate.canonical_revision !== undefined &&
		(!Number.isInteger(candidate.canonical_revision) ||
			Number(candidate.canonical_revision) < 0)
	)
		return false;
	if (
		candidate.rollback_audit !== undefined &&
		(typeof candidate.rollback_audit !== "string" ||
			candidate.rollback_audit.length === 0 ||
			path.isAbsolute(candidate.rollback_audit) ||
			candidate.rollback_audit.split(path.sep).includes(".."))
	)
		return false;
	return true;
}

export function controlPlaneAuthorityPath(home: string): string {
	return path.join(path.resolve(home), "control-plane", "authority.json");
}

export function defaultControlPlaneAuthority(): ControlPlaneAuthority {
	return Object.freeze({
		schema_version: controlPlaneAuthoritySchemaVersion,
		stage: "C3",
		write_policy: "legacy_open",
		revision: 0,
		updated_at: "1970-01-01T00:00:00.000Z",
	});
}

/**
 * Missing state is deliberately C3: installing the dark control plane must not
 * retire a legacy writer. Invalid state fails closed because guessing between
 * two authorities would be worse than refusing to start.
 */
export function readControlPlaneAuthority(home: string): ControlPlaneAuthority {
	const target = controlPlaneAuthorityPath(home);
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
		if (!validAuthority(parsed))
			throw new Error("control-plane authority pointer is invalid");
		return Object.freeze({ ...parsed });
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return defaultControlPlaneAuthority();
		throw error;
	}
}

/** Atomic single-pointer switch shared by cutover and rollback. */
export function writeControlPlaneAuthority(
	home: string,
	update: ControlPlaneAuthorityUpdate,
): ControlPlaneAuthority {
	const current = readControlPlaneAuthority(home);
	const next: ControlPlaneAuthority = Object.freeze({
		schema_version: controlPlaneAuthoritySchemaVersion,
		stage: update.stage,
		write_policy: update.write_policy,
		revision: current.revision + 1,
		updated_at: update.updated_at ?? new Date().toISOString(),
		...(update.plan_hash ? { plan_hash: update.plan_hash } : {}),
		...(update.canonical_revision === undefined
			? {}
			: { canonical_revision: update.canonical_revision }),
		...(update.rollback_audit ? { rollback_audit: update.rollback_audit } : {}),
	});
	if (!validAuthority(next))
		throw new Error("control-plane authority update is invalid");
	const target = controlPlaneAuthorityPath(home);
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = path.join(
		path.dirname(target),
		`.authority.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	return next;
}

export function resolveControlPlanePersistencePaths(
	home: string,
): Readonly<PersistencePaths & { authority: ControlPlaneAuthority }> {
	const authority = readControlPlaneAuthority(home);
	const runtimeRoot =
		authority.stage === "C4"
			? path.join(path.resolve(home), "canonical")
			: path.resolve(home);
	return Object.freeze({
		// GOL-20 keeps tracker as its own authority. C4 switches only the
		// project/session/endpoint runtime store; moving tracker history to the
		// migration scratch database would silently discard real work.
		runtimePath: path.join(runtimeRoot, "runtime.db"),
		trackerPath: path.join(path.resolve(home), "tracker.db"),
		lockPath: path.join(
			path.resolve(home),
			"control-plane",
			"persistence.owner.lock",
		),
		authority,
	});
}
