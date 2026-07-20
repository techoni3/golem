import fs from "node:fs";
import path from "node:path";

export interface ServiceLock {
	readonly path: string;
	release(): void;
}

export interface ServiceLockStatus {
	readonly state: "absent" | "active" | "stale" | "invalid";
	readonly path: string;
	readonly ownerPid?: number;
}

export function acquireServiceLock(stateDirectory: string): ServiceLock {
	fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	const lockPath = path.join(stateDirectory, "control-plane.lock");
	for (let attempts = 0; attempts < 2; attempts += 1) {
		try {
			const descriptor = fs.openSync(lockPath, "wx", 0o600);
			fs.writeFileSync(
				descriptor,
				`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
				"utf8",
			);
			fs.closeSync(descriptor);
			break;
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			if (!removeStaleLock(lockPath))
				throw new Error(
					`control-plane service lock already exists: ${lockPath}`,
				);
		}
	}
	if (!fs.existsSync(lockPath))
		throw new Error(
			`control-plane could not acquire service lock: ${lockPath}`,
		);
	let released = false;
	return Object.freeze({
		path: lockPath,
		release: () => {
			if (released) return;
			released = true;
			try {
				fs.unlinkSync(lockPath);
			} catch (error) {
				if (!isCode(error, "ENOENT")) throw error;
			}
		},
	});
}

export function serviceLockStatus(stateDirectory: string): ServiceLockStatus {
	const lockPath = path.join(stateDirectory, "control-plane.lock");
	if (!fs.existsSync(lockPath))
		return Object.freeze({ state: "absent", path: lockPath });
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
			pid?: unknown;
		};
		const pid = parsed.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
			return Object.freeze({ state: "invalid", path: lockPath });
		try {
			process.kill(pid, 0);
			return Object.freeze({ state: "active", path: lockPath, ownerPid: pid });
		} catch (error) {
			if (!isCode(error, "ESRCH"))
				return Object.freeze({
					state: "active",
					path: lockPath,
					ownerPid: pid,
				});
			return Object.freeze({ state: "stale", path: lockPath, ownerPid: pid });
		}
	} catch {
		return Object.freeze({ state: "invalid", path: lockPath });
	}
}

function removeStaleLock(lockPath: string): boolean {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
			pid?: unknown;
		};
		const pid = parsed.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
			return false;
		try {
			process.kill(pid, 0);
			return false;
		} catch (error) {
			if (!isCode(error, "ESRCH")) return false;
		}
		fs.unlinkSync(lockPath);
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT")) return true;
		return false;
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
