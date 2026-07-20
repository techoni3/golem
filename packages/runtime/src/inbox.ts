import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type RuntimeSignalV1, RuntimeSignalV1Schema } from "@golem/contracts";

const fileSystem = fs as typeof fs & {
	fsyncSync(descriptor: number): void;
};

const maxSignalBytes = 1_048_576;
const defaultClaimLeaseMs = 30_000;
const defaultMaxAttempts = 3;

export interface InboxReceipt {
	readonly eventId: string;
	readonly status: "spooled" | "already_pending";
}

export interface RuntimeInboxMetrics {
	readonly pending: number;
	readonly processing: number;
	readonly archived: number;
	readonly quarantined: number;
	readonly retrying: number;
	readonly oldestPendingAgeMs?: number;
	readonly oldestRetryAgeMs?: number;
}

/** Injectable only for crash-boundary verification; production leaves it empty. */
export interface RuntimeInboxOptions {
	readonly afterTemporaryFsync?: () => void;
	readonly now?: () => number;
	readonly claimLeaseMs?: number;
	readonly maxAttempts?: number;
}

export interface ClaimedInboxEntry {
	readonly eventId: string;
	readonly claimPath: string;
	readonly attempt: number;
	/** Bytes are intentionally runtime-agnostic in the public declaration. */
	readonly raw: Uint8Array;
}

interface RetryMetadata {
	readonly attempts: number;
	readonly nextAttemptAt: number;
	readonly lastError: string;
}

interface ClaimMetadata {
	readonly eventId: string;
	readonly attempt: number;
	readonly claimedAt: number;
	readonly leaseMs: number;
	readonly token: string;
}

function fsyncDirectory(directory: string): void {
	const descriptor = fileSystem.openSync(directory, "r");
	try {
		fileSystem.fsyncSync(descriptor);
	} finally {
		fileSystem.closeSync(descriptor);
	}
}

function isEnvelopeFile(name: string): boolean {
	return name.endsWith(".json") && !name.endsWith(".metadata.json");
}

function countEnvelopeFiles(directory: string): number {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && isEnvelopeFile(entry.name)).length;
}

function eventFileName(eventId: string): string {
	// RuntimeSignalV1 already constrains ids. Retain an independent filesystem
	// guard so callers cannot turn an envelope id into a path traversal.
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(eventId))
		throw new Error("runtime inbox event id is not filesystem-safe");
	return `${eventId}.json`;
}

function redactDiagnostic(value: string): string {
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
		.replace(
			/\b(token|authorization|password|secret)=([^\s&]+)/giu,
			"$1=[REDACTED]",
		)
		.replace(/\/[A-Za-z0-9._~\-/]{12,}/gu, "[PATH]")
		.slice(0, 512);
}

function retryDelayMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function claimFileName(metadata: ClaimMetadata): string {
	return `${metadata.eventId}~${metadata.attempt}~${metadata.claimedAt}~${metadata.leaseMs}~${metadata.token}.json`;
}

function parseClaimFileName(name: string): ClaimMetadata | undefined {
	if (!name.endsWith(".json")) return undefined;
	const stem = name.slice(0, -".json".length);
	const fields = stem.split("~");
	if (fields.length !== 5) return undefined;
	const [eventId, attemptText, claimedAtText, leaseText, token] = fields;
	const attempt = Number(attemptText);
	const claimedAt = Number(claimedAtText);
	const leaseMs = Number(leaseText);
	if (
		!eventId ||
		!token ||
		!Number.isInteger(attempt) ||
		attempt < 1 ||
		!Number.isFinite(claimedAt) ||
		!Number.isInteger(leaseMs) ||
		leaseMs < 1
	)
		return undefined;
	return Object.freeze({ eventId, attempt, claimedAt, leaseMs, token });
}

/** Atomic per-home spool that never gives producers a database capability. */
export class RuntimeInbox {
	readonly #root: string;
	readonly #pending: string;
	readonly #processing: string;
	readonly #archived: string;
	readonly #quarantine: string;
	readonly #retry: string;
	readonly #afterTemporaryFsync: (() => void) | undefined;
	readonly #now: () => number;
	readonly #claimLeaseMs: number;
	readonly #maxAttempts: number;

	constructor(home: string, options: RuntimeInboxOptions = {}) {
		this.#root = path.join(home, "inbox");
		this.#pending = path.join(this.#root, "pending");
		this.#processing = path.join(this.#root, "processing");
		this.#archived = path.join(this.#root, "archived");
		this.#quarantine = path.join(this.#root, "quarantine");
		this.#retry = path.join(this.#root, "retry");
		for (const directory of [
			this.#pending,
			this.#processing,
			this.#archived,
			this.#quarantine,
			this.#retry,
		])
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.#afterTemporaryFsync = options.afterTemporaryFsync;
		this.#now = options.now ?? Date.now;
		this.#claimLeaseMs = options.claimLeaseMs ?? defaultClaimLeaseMs;
		this.#maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
		if (!Number.isInteger(this.#claimLeaseMs) || this.#claimLeaseMs < 1)
			throw new Error("runtime inbox claim lease must be positive");
		if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1)
			throw new Error("runtime inbox max attempts must be positive");
	}

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
			// the first complete envelope.
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
		const now = this.#now();
		const candidates = fs
			.readdirSync(this.#pending, { withFileTypes: true })
			.filter((entry) => entry.isFile() && isEnvelopeFile(entry.name))
			.map((entry) => entry.name)
			.filter((name) => {
				const retry = this.#readRetry(name.slice(0, -".json".length));
				return !retry || retry.nextAttemptAt <= now;
			})
			.sort()
			.slice(0, limit);
		const claimed: ClaimedInboxEntry[] = [];
		for (const name of candidates) {
			const eventId = name.slice(0, -".json".length);
			const retry = this.#readRetry(eventId);
			const metadata: ClaimMetadata = {
				eventId,
				attempt: (retry?.attempts ?? 0) + 1,
				claimedAt: now,
				leaseMs: this.#claimLeaseMs,
				token: crypto.randomUUID(),
			};
			const claimPath = path.join(this.#processing, claimFileName(metadata));
			try {
				fs.renameSync(path.join(this.#pending, name), claimPath);
				fsyncDirectory(this.#pending);
				fsyncDirectory(this.#processing);
				claimed.push(
					Object.freeze({
						eventId,
						claimPath,
						attempt: metadata.attempt,
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
		const now = this.#now();
		for (const entry of fs.readdirSync(this.#processing, {
			withFileTypes: true,
		})) {
			if (!entry.isFile() || !isEnvelopeFile(entry.name)) continue;
			const metadata = parseClaimFileName(entry.name);
			if (!metadata) {
				this.#quarantinePath(
					path.join(this.#processing, entry.name),
					"invalid_claim_metadata",
					1,
					"claim metadata is invalid",
				);
				continue;
			}
			if (metadata.claimedAt + metadata.leaseMs > now) continue;
			const pathToClaim = path.join(this.#processing, entry.name);
			if (metadata.attempt >= this.#maxAttempts) {
				this.#quarantinePath(
					pathToClaim,
					"lease_expired",
					metadata.attempt,
					"claim lease expired after bounded attempts",
				);
				reclaimed += 1;
				continue;
			}
			this.#returnToPending(
				pathToClaim,
				metadata.eventId,
				metadata.attempt,
				"claim lease expired",
				0,
			);
			reclaimed += 1;
		}
		return reclaimed;
	}

	retry(entry: ClaimedInboxEntry, reason: string): "retrying" | "quarantined" {
		if (!fs.existsSync(entry.claimPath)) return "retrying";
		if (entry.attempt >= this.#maxAttempts) {
			this.#quarantinePath(entry.claimPath, "poison", entry.attempt, reason);
			return "quarantined";
		}
		this.#returnToPending(
			entry.claimPath,
			entry.eventId,
			entry.attempt,
			reason,
			retryDelayMs(entry.attempt),
		);
		return "retrying";
	}

	archive(entry: ClaimedInboxEntry): void {
		if (!fs.existsSync(entry.claimPath)) return;
		const target = path.join(this.#archived, eventFileName(entry.eventId));
		try {
			fileSystem.linkSync(entry.claimPath, target);
			fsyncDirectory(this.#archived);
			fileSystem.unlinkSync(entry.claimPath);
			fsyncDirectory(this.#processing);
			this.#removeRetry(entry.eventId);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const original = fs.readFileSync(target);
		const duplicate = fs.readFileSync(entry.claimPath);
		if (original.equals(duplicate)) {
			fs.unlinkSync(entry.claimPath);
			fsyncDirectory(this.#processing);
			this.#removeRetry(entry.eventId);
			return;
		}
		this.#quarantinePath(
			entry.claimPath,
			"archive_conflict",
			entry.attempt,
			"archive target exists with different raw envelope",
		);
	}

	quarantine(entry: ClaimedInboxEntry, reason: string): void {
		this.#quarantinePath(entry.claimPath, reason, entry.attempt, reason);
	}

	metrics(now = this.#now()): RuntimeInboxMetrics {
		const pendingEntries = fs
			.readdirSync(this.#pending, { withFileTypes: true })
			.filter((entry) => entry.isFile() && isEnvelopeFile(entry.name));
		const oldest = pendingEntries
			.map((entry) => fs.statSync(path.join(this.#pending, entry.name)).mtimeMs)
			.sort((left, right) => left - right)[0];
		const retries = fs
			.readdirSync(this.#retry, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => this.#readRetry(entry.name.slice(0, -".json".length)))
			.filter((value): value is RetryMetadata => value !== undefined);
		const oldestRetry = retries
			.map((entry) => entry.nextAttemptAt)
			.sort((left, right) => left - right)[0];
		return Object.freeze({
			pending: pendingEntries.length,
			processing: countEnvelopeFiles(this.#processing),
			archived: countEnvelopeFiles(this.#archived),
			quarantined: countEnvelopeFiles(this.#quarantine),
			retrying: retries.length,
			...(oldest === undefined
				? {}
				: { oldestPendingAgeMs: Math.max(0, now - oldest) }),
			...(oldestRetry === undefined
				? {}
				: { oldestRetryAgeMs: Math.max(0, now - oldestRetry) }),
		});
	}

	#readRetry(eventId: string): RetryMetadata | undefined {
		const source = path.join(this.#retry, eventFileName(eventId));
		if (!fs.existsSync(source)) return undefined;
		try {
			const decoded = JSON.parse(
				fs.readFileSync(source, "utf8"),
			) as RetryMetadata;
			if (
				!Number.isInteger(decoded.attempts) ||
				decoded.attempts < 1 ||
				!Number.isFinite(decoded.nextAttemptAt) ||
				typeof decoded.lastError !== "string"
			)
				return undefined;
			return Object.freeze(decoded);
		} catch {
			return undefined;
		}
	}

	#writeRetry(eventId: string, metadata: RetryMetadata): void {
		const target = path.join(this.#retry, eventFileName(eventId));
		const temporary = path.join(
			this.#retry,
			`.${eventId}.${crypto.randomUUID()}.tmp`,
		);
		const descriptor = fileSystem.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
			0o600,
		);
		try {
			fileSystem.writeFileSync(descriptor, JSON.stringify(metadata));
			fileSystem.fsyncSync(descriptor);
		} finally {
			fileSystem.closeSync(descriptor);
		}
		fs.renameSync(temporary, target);
		fsyncDirectory(this.#retry);
	}

	#removeRetry(eventId: string): void {
		const target = path.join(this.#retry, eventFileName(eventId));
		if (!fs.existsSync(target)) return;
		fs.unlinkSync(target);
		fsyncDirectory(this.#retry);
	}

	#returnToPending(
		claimPath: string,
		eventId: string,
		attempt: number,
		reason: string,
		delayMs: number,
	): void {
		this.#writeRetry(eventId, {
			attempts: attempt,
			nextAttemptAt: this.#now() + delayMs,
			lastError: redactDiagnostic(reason),
		});
		const target = path.join(this.#pending, eventFileName(eventId));
		try {
			fileSystem.linkSync(claimPath, target);
			fsyncDirectory(this.#pending);
			fileSystem.unlinkSync(claimPath);
			fsyncDirectory(this.#processing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Another recovery already retained the immutable source envelope. The
			// claimed copy can be discarded without replacing that evidence.
			if (fs.existsSync(claimPath)) {
				fs.unlinkSync(claimPath);
				fsyncDirectory(this.#processing);
			}
		}
	}

	#quarantinePath(
		claimPath: string,
		reason: string,
		attempt: number,
		diagnostic: string,
	): void {
		if (!fs.existsSync(claimPath)) return;
		const safeReason = reason.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64);
		const base = `${path.basename(claimPath, ".json")}.${safeReason || "invalid"}.${crypto.randomUUID()}`;
		const target = path.join(this.#quarantine, `${base}.json`);
		fileSystem.linkSync(claimPath, target);
		fsyncDirectory(this.#quarantine);
		fileSystem.writeFileSync(
			path.join(this.#quarantine, `${base}.metadata.json`),
			JSON.stringify({
				reason: safeReason || "invalid",
				attempt,
				diagnostic: redactDiagnostic(diagnostic),
			}),
			{ mode: 0o600 },
		);
		fsyncDirectory(this.#quarantine);
		fs.unlinkSync(claimPath);
		fsyncDirectory(this.#processing);
		const metadata = parseClaimFileName(path.basename(claimPath));
		if (metadata) this.#removeRetry(metadata.eventId);
	}
}
