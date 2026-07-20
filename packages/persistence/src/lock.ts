import fs from "node:fs";
import path from "node:path";

import { PersistenceOwnerConflictError } from "./types.js";

const fileSystem = fs as {
	closeSync(descriptor: number): void;
	mkdirSync(target: string, options: { recursive: true; mode: number }): void;
	openSync(target: string, flags: "wx", mode: number): number;
	readFileSync(target: string, encoding: "utf8"): string;
	unlinkSync(target: string): void;
	writeFileSync(descriptor: number, value: string): void;
};
const pathBoundary = path as { dirname(target: string): string };

function now(): string {
	return new Date().toISOString();
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

function ownerMetadata(lockPath: string): Record<string, unknown> {
	try {
		return JSON.parse(fileSystem.readFileSync(lockPath, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return { status: "unreadable" };
	}
}

export function acquireOwnerLock(lockPath: string, ownerId: string): void {
	fileSystem.mkdirSync(pathBoundary.dirname(lockPath), {
		recursive: true,
		mode: 0o700,
	});
	const metadata = { owner_id: ownerId, pid: process.pid, acquired_at: now() };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const descriptor = fileSystem.openSync(lockPath, "wx", 0o600);
			try {
				fileSystem.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`);
			} finally {
				fileSystem.closeSync(descriptor);
			}
			return;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? error.code
					: undefined;
			if (code !== "EEXIST") throw error;
			const existing = ownerMetadata(lockPath);
			if (
				attempt === 0 &&
				typeof existing.pid === "number" &&
				processIsGone(existing.pid)
			) {
				fileSystem.unlinkSync(lockPath);
				continue;
			}
			throw new PersistenceOwnerConflictError(existing);
		}
	}
}

export function releaseOwnerLock(lockPath: string): void {
	try {
		fileSystem.unlinkSync(lockPath);
	} catch (error) {
		if (
			!(
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			)
		)
			throw error;
	}
}
