import fs from "node:fs";
import path from "node:path";

import { createOwnerNonce } from "./clock.js";
import type { PersistenceClock } from "./types.js";
import { PersistenceOwnerConflictError } from "./types.js";

const fileSystem = fs as unknown as {
	mkdirSync(
		target: string,
		options: { readonly recursive?: boolean; readonly mode: number },
	): void;
	readFileSync(target: string, encoding: "utf8"): string;
	renameSync(from: string, to: string): void;
	rmSync(
		target: string,
		options: { readonly force: boolean; readonly recursive: boolean },
	): void;
	writeFileSync(
		target: string,
		value: string,
		options?: { readonly encoding: "utf8"; readonly mode: number },
	): void;
};

interface OwnerMetadata {
	readonly owner_id: string;
	readonly pid: number;
	readonly nonce: string;
	readonly acquired_at: string;
}

export interface AcquiredOwnerLock {
	readonly lockPath: string;
	readonly guardPath: string;
	readonly ownerId: string;
	readonly nonce: string;
	readonly pid: number;
}

function guardPath(lockPath: string): string {
	return `${lockPath}.guard`;
}

function metadataPath(ownerGuardPath: string): string {
	return path.join(ownerGuardPath, "owner.json");
}

function processIsGone(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
}

function readOwnerMetadata(target: string): OwnerMetadata | undefined {
	try {
		const parsed = JSON.parse(
			fileSystem.readFileSync(metadataPath(target), "utf8"),
		) as Partial<OwnerMetadata>;
		if (
			typeof parsed.owner_id !== "string" ||
			!parsed.owner_id ||
			typeof parsed.pid !== "number" ||
			!Number.isSafeInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			typeof parsed.nonce !== "string" ||
			!/^owner_[0-9a-f-]{36}$/iu.test(parsed.nonce) ||
			typeof parsed.acquired_at !== "string"
		)
			return undefined;
		return Object.freeze({
			owner_id: parsed.owner_id,
			pid: parsed.pid,
			nonce: parsed.nonce,
			acquired_at: parsed.acquired_at,
		});
	} catch {
		return undefined;
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

function isSameOwner(
	lock: AcquiredOwnerLock,
	current: OwnerMetadata | undefined,
): boolean {
	return Boolean(
		current &&
			current.owner_id === lock.ownerId &&
			current.pid === lock.pid &&
			current.nonce === lock.nonce,
	);
}

/** The nonce-bearing directory is authoritative; the file is diagnostics only. */
function writeDiagnosticPointer(
	lockPath: string,
	metadata: OwnerMetadata,
): void {
	const temporary = `${lockPath}.${metadata.nonce}.tmp`;
	fileSystem.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	fileSystem.renameSync(temporary, lockPath);
}

function recoverStaleGuard(
	ownerGuardPath: string,
	expected: OwnerMetadata,
): boolean {
	const current = readOwnerMetadata(ownerGuardPath);
	if (
		!current ||
		current.nonce !== expected.nonce ||
		current.owner_id !== expected.owner_id ||
		!processIsGone(current.pid)
	)
		return false;
	try {
		fileSystem.renameSync(
			ownerGuardPath,
			`${ownerGuardPath}.stale-${current.nonce}`,
		);
		return true;
	} catch {
		return false;
	}
}

export function acquireOwnerLock(
	lockPath: string,
	ownerId: string,
	clock: PersistenceClock,
): AcquiredOwnerLock {
	fileSystem.mkdirSync(path.dirname(lockPath), {
		recursive: true,
		mode: 0o700,
	});
	const ownerGuardPath = guardPath(lockPath);
	const metadata: OwnerMetadata = Object.freeze({
		owner_id: ownerId,
		pid: process.pid,
		nonce: createOwnerNonce(),
		acquired_at: clock.now(),
	});
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			fileSystem.mkdirSync(ownerGuardPath, { mode: 0o700 });
			fileSystem.writeFileSync(
				metadataPath(ownerGuardPath),
				`${JSON.stringify(metadata)}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
			writeDiagnosticPointer(lockPath, metadata);
			return Object.freeze({
				lockPath,
				guardPath: ownerGuardPath,
				ownerId,
				nonce: metadata.nonce,
				pid: process.pid,
			});
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			const existing = readOwnerMetadata(ownerGuardPath);
			if (attempt === 0 && existing && processIsGone(existing.pid)) {
				if (recoverStaleGuard(ownerGuardPath, existing)) continue;
			}
			throw new PersistenceOwnerConflictError(
				existing
					? {
							owner_id: existing.owner_id,
							owner_nonce: existing.nonce,
							pid: existing.pid,
							state: processIsGone(existing.pid)
								? "stale_recovery_raced"
								: "active",
						}
					: { state: "invalid", lock_path: lockPath },
			);
		}
	}
	throw new PersistenceOwnerConflictError({
		state: "recovery_exhausted",
		lock_path: lockPath,
	});
}

/** Release only this acquired nonce; a pointer replacement is never deleted. */
export function releaseOwnerLock(lock: AcquiredOwnerLock): void {
	if (!isSameOwner(lock, readOwnerMetadata(lock.guardPath))) return;
	try {
		fileSystem.rmSync(lock.guardPath, { recursive: true, force: true });
	} catch (error) {
		if (!isCode(error, "ENOENT")) throw error;
	}
}
