import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface ServiceLockRecord {
	readonly pid: number;
	readonly nonce: string;
	readonly started_at: string;
}

export interface ServiceLock {
	readonly path: string;
	readonly nonce: string;
	release(): void;
}

export interface ServiceLockStatus {
	readonly state: "absent" | "active" | "stale" | "invalid";
	readonly path: string;
	readonly detail: string;
	readonly ownerPid?: number;
	readonly ownerNonce?: string;
}

function lockPathFor(stateDirectory: string): string {
	return path.join(stateDirectory, "control-plane.lock");
}

function recoveryPath(lockPath: string): string {
	return `${lockPath}.recovery`;
}

function isCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function processIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return isCode(error, "ESRCH");
	}
}

function readRecord(lockPath: string): ServiceLockRecord | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
			pid?: unknown;
			nonce?: unknown;
			started_at?: unknown;
		};
		if (
			typeof parsed.pid !== "number" ||
			!Number.isInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			typeof parsed.nonce !== "string" ||
			!/^lock_[0-9a-f-]{36}$/iu.test(parsed.nonce) ||
			typeof parsed.started_at !== "string"
		)
			return undefined;
		return Object.freeze({
			pid: parsed.pid,
			nonce: parsed.nonce,
			started_at: parsed.started_at,
		});
	} catch {
		return undefined;
	}
}

export function serviceLockStatus(stateDirectory: string): ServiceLockStatus {
	const lockPath = lockPathFor(stateDirectory);
	if (!fs.existsSync(lockPath))
		return Object.freeze({
			state: "absent",
			path: lockPath,
			detail: "no owner lock exists",
		});
	const record = readRecord(lockPath);
	if (!record)
		return Object.freeze({
			state: "invalid",
			path: lockPath,
			detail: "lock metadata is malformed; inspect or remove it manually",
		});
	if (processIsGone(record.pid))
		return Object.freeze({
			state: "stale",
			path: lockPath,
			ownerPid: record.pid,
			ownerNonce: record.nonce,
			detail: `owner pid ${record.pid} is gone and may be recovered`,
		});
	return Object.freeze({
		state: "active",
		path: lockPath,
		ownerPid: record.pid,
		ownerNonce: record.nonce,
		detail: `owner pid ${record.pid} is still active`,
	});
}

function reclaimStaleLock(lockPath: string): boolean {
	const guardPath = recoveryPath(lockPath);
	let descriptor: number | undefined;
	let recovered = false;
	try {
		descriptor = fs.openSync(guardPath, "wx", 0o600);
		fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
		fs.closeSync(descriptor);
		descriptor = undefined;
		const status = serviceLockStatus(path.dirname(lockPath));
		if (status.state === "stale") {
			const quarantine = `${lockPath}.stale-${status.ownerNonce}`;
			fs.renameSync(lockPath, quarantine);
			recovered = true;
		}
	} catch {
		if (descriptor !== undefined)
			try {
				fs.closeSync(descriptor);
			} catch {
				// The exclusive recovery guard is retained if it cannot be closed.
			}
	}
	try {
		fs.unlinkSync(guardPath);
	} catch (error) {
		if (!isCode(error, "ENOENT")) return false;
	}
	return recovered;
}

export function acquireServiceLock(stateDirectory: string): ServiceLock {
	fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	const lockPath = lockPathFor(stateDirectory);
	const record = Object.freeze({
		pid: process.pid,
		nonce: `lock_${crypto.randomUUID()}`,
		started_at: new Date().toISOString(),
	});
	for (let attempts = 0; attempts < 3; attempts += 1) {
		try {
			const descriptor = fs.openSync(lockPath, "wx", 0o600);
			try {
				fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
			} finally {
				fs.closeSync(descriptor);
			}
			let released = false;
			return Object.freeze({
				path: lockPath,
				nonce: record.nonce,
				release: () => {
					if (released) return;
					released = true;
					const current = readRecord(lockPath);
					if (
						!current ||
						current.pid !== record.pid ||
						current.nonce !== record.nonce
					)
						return;
					try {
						fs.unlinkSync(lockPath);
					} catch (error) {
						if (!isCode(error, "ENOENT")) throw error;
					}
				},
			});
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			const status = serviceLockStatus(stateDirectory);
			if (status.state === "stale" && reclaimStaleLock(lockPath)) continue;
			throw new Error(
				`control-plane service lock ${status.state}: ${status.detail} (${lockPath})`,
			);
		}
	}
	throw new Error(`control-plane could not acquire service lock: ${lockPath}`);
}
