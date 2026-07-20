import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type RuntimeSignalV1, RuntimeSignalV1Schema } from "@golem/contracts";

const fileSystem = fs as typeof fs & {
	fsyncSync(descriptor: number): void;
};

const maxSignalBytes = 1_048_576;

export interface InboxReceipt {
	readonly eventId: string;
	readonly status: "spooled" | "already_pending";
}

export interface RuntimeInboxMetrics {
	readonly pending: number;
	readonly processing: number;
	readonly archived: number;
	readonly quarantined: number;
	readonly oldestPendingAgeMs?: number;
}

/** Injectable only for crash-boundary verification; production leaves it empty. */
export interface RuntimeInboxOptions {
	readonly afterTemporaryFsync?: () => void;
}

export interface ClaimedInboxEntry {
	readonly eventId: string;
	readonly claimPath: string;
	/** Bytes are intentionally runtime-agnostic in the public declaration. */
	readonly raw: Uint8Array;
}

function fsyncDirectory(directory: string): void {
	const descriptor = fileSystem.openSync(directory, "r");
	try {
		fileSystem.fsyncSync(descriptor);
	} finally {
		fileSystem.closeSync(descriptor);
	}
}

function countFiles(directory: string): number {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile()).length;
}

function eventFileName(eventId: string): string {
	// RuntimeSignalV1 already constrains ids. Retain an independent filesystem
	// guard so callers cannot turn an envelope id into a path traversal.
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(eventId))
		throw new Error("runtime inbox event id is not filesystem-safe");
	return `${eventId}.json`;
}

/** Atomic per-home spool that never gives producers a database capability. */
export class RuntimeInbox {
	readonly #root: string;
	readonly #pending: string;
	readonly #processing: string;
	readonly #archived: string;
	readonly #quarantine: string;

	constructor(home: string, options: RuntimeInboxOptions = {}) {
		this.#root = path.join(home, "inbox");
		this.#pending = path.join(this.#root, "pending");
		this.#processing = path.join(this.#root, "processing");
		this.#archived = path.join(this.#root, "archived");
		this.#quarantine = path.join(this.#root, "quarantine");
		for (const directory of [
			this.#pending,
			this.#processing,
			this.#archived,
			this.#quarantine,
		])
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.#afterTemporaryFsync = options.afterTemporaryFsync;
	}

	readonly #afterTemporaryFsync: (() => void) | undefined;

	get root(): string {
		return this.#root;
	}

	accept(signal: RuntimeSignalV1): InboxReceipt {
		const parsed = RuntimeSignalV1Schema.parse(signal);
		const body = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
		if (body.byteLength > maxSignalBytes)
			throw new Error("runtime signal exceeds the 1 MiB inbox limit");
		const target = path.join(this.#pending, eventFileName(parsed.event_id));
		const temporary = path.join(
			this.#pending,
			`.${parsed.event_id}.${crypto.randomUUID()}.tmp`,
		);
		let descriptor: number | undefined;
		try {
			descriptor = fileSystem.openSync(
				temporary,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
				0o600,
			);
			fileSystem.writeFileSync(descriptor, body);
			fileSystem.fsyncSync(descriptor);
			fileSystem.closeSync(descriptor);
			descriptor = undefined;
			this.#afterTemporaryFsync?.();
			// `link` is an atomic no-clobber publish. POSIX rename overwrites an
			// existing path, which would make concurrent duplicate producers lose
			// the first complete envelope. The temporary file is unlinked only after
			// the published name is durably visible.
			try {
				fileSystem.linkSync(temporary, target);
				fsyncDirectory(this.#pending);
				fileSystem.unlinkSync(temporary);
				fsyncDirectory(this.#pending);
				return Object.freeze({ eventId: parsed.event_id, status: "spooled" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					return Object.freeze({
						eventId: parsed.event_id,
						status: "already_pending",
					});
				throw error;
			}
		} finally {
			if (descriptor !== undefined) fileSystem.closeSync(descriptor);
			if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
		}
	}

	/** Control-plane port name; it deliberately has the same filesystem-only semantics. */
	ingest(signal: RuntimeSignalV1): InboxReceipt {
		return this.accept(signal);
	}

	claim(limit = 100): readonly ClaimedInboxEntry[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error(
				"runtime inbox claim limit must be an integer from 1 to 100",
			);
		const candidates = fs
			.readdirSync(this.#pending, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name)
			.sort()
			.slice(0, limit);
		const claimed: ClaimedInboxEntry[] = [];
		for (const name of candidates) {
			const eventId = name.slice(0, -".json".length);
			const claimPath = path.join(
				this.#processing,
				`${eventId}.${crypto.randomUUID()}.json`,
			);
			try {
				fs.renameSync(path.join(this.#pending, name), claimPath);
				fsyncDirectory(this.#pending);
				fsyncDirectory(this.#processing);
				claimed.push(
					Object.freeze({
						eventId,
						claimPath,
						raw: fs.readFileSync(claimPath),
					}),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return Object.freeze(claimed);
	}

	reclaimProcessing(): number {
		let reclaimed = 0;
		for (const entry of fs.readdirSync(this.#processing, {
			withFileTypes: true,
		})) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const eventId = entry.name.split(".")[0];
			if (!eventId) continue;
			const target = path.join(this.#pending, eventFileName(eventId));
			try {
				// A committed-but-unarchived event may already be pending after a
				// previous recovery. Preserve exactly one source envelope.
				if (fs.existsSync(target))
					fs.unlinkSync(path.join(this.#processing, entry.name));
				else fs.renameSync(path.join(this.#processing, entry.name), target);
				fsyncDirectory(this.#pending);
				fsyncDirectory(this.#processing);
				reclaimed += 1;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return reclaimed;
	}

	archive(entry: ClaimedInboxEntry): void {
		const target = path.join(this.#archived, eventFileName(entry.eventId));
		if (fs.existsSync(entry.claimPath)) fs.renameSync(entry.claimPath, target);
		fsyncDirectory(this.#archived);
		fsyncDirectory(this.#processing);
	}

	quarantine(entry: ClaimedInboxEntry, reason: string): void {
		const safeReason = reason.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64);
		const target = path.join(
			this.#quarantine,
			`${entry.eventId}.${safeReason || "invalid"}.json`,
		);
		if (fs.existsSync(entry.claimPath)) fs.renameSync(entry.claimPath, target);
		fsyncDirectory(this.#quarantine);
		fsyncDirectory(this.#processing);
	}

	metrics(now = Date.now()): RuntimeInboxMetrics {
		const pendingEntries = fs
			.readdirSync(this.#pending, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
		const oldest = pendingEntries
			.map((entry) => fs.statSync(path.join(this.#pending, entry.name)).mtimeMs)
			.sort((left, right) => left - right)[0];
		return Object.freeze({
			pending: pendingEntries.length,
			processing: countFiles(this.#processing),
			archived: countFiles(this.#archived),
			quarantined: countFiles(this.#quarantine),
			...(oldest === undefined
				? {}
				: { oldestPendingAgeMs: Math.max(0, now - oldest) }),
		});
	}
}
