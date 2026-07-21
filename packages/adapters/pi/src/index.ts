import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AdapterBoundary } from "@golem/adapter-sdk";
import type { ApiClientBoundary } from "@golem/api-client";
import {
	type RuntimeSignalKind,
	type RuntimeSignalV1,
	RuntimeSignalV1Schema,
} from "@golem/contracts";

/**
 * A Pi process is deliberately given this binding by composition.  It must
 * never derive canonical ids from a raw Pi transcript/session filename: doing
 * that is precisely how aliases turn into ghost sessions after a resume.
 */
export interface PiSessionBinding {
	readonly projectId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly endpointId: string;
	/** Decimal text of the control-plane issued endpoint fence. */
	readonly ownerFence: string;
	readonly producerInstanceId: string;
}

export interface PiAdapterBoundary {
	readonly adapter: AdapterBoundary;
}

export interface PiLifecycleInput {
	readonly event:
		| "started"
		| "resumed"
		| "activity"
		| "idle"
		| "waiting"
		| "metadata"
		| "ended";
	readonly observedAt?: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
	readonly activityKind?: "prompt" | "tool" | "response" | "work";
	readonly waitingReason?: string;
	readonly disposition?: "ended" | "errored" | "superseded";
}

export interface PiControlPort {
	ingest(signal: RuntimeSignalV1): Promise<void>;
	claimNextTurn(input: {
		readonly binding: PiSessionBinding;
		readonly limit?: number;
		readonly leaseMs?: number;
	}): Promise<readonly PiRemoteClaim[]>;
	prepare(claimToken: string): Promise<PiPrepareResult>;
	acknowledge(input: {
		readonly claimToken: string;
		readonly acknowledgementId: string;
		readonly payload?: Readonly<Record<string, unknown>>;
	}): Promise<void>;
	delivered(claimToken: string): Promise<void>;
	fail(input: {
		readonly claimToken: string;
		readonly error: string;
	}): Promise<void>;
}

export interface PiRemoteClaim {
	readonly deliveryId: string;
	readonly claimToken: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly endpoint: Readonly<Record<string, unknown>>;
}

export type PiPrepareResult =
	| { readonly kind: "deliver"; readonly claim: PiRemoteClaim }
	| {
			readonly kind: "stale";
			readonly reason: "endpoint_changed" | "ineligible";
	  };

export interface PiQueuedTurn {
	readonly deliveryId: string;
	readonly claimToken: string;
	readonly text: string;
}

export interface PiClaimedTurn extends PiQueuedTurn {
	readonly attempt: number;
}

export interface PiPendingAcknowledgement extends PiQueuedTurn {
	readonly acknowledgementId: string;
}

export interface PiNextTurnDiagnostics {
	readonly pending: number;
	readonly processing: number;
	readonly acknowledgements: number;
	readonly deadLetters: number;
	readonly retrying: number;
}

export interface PiNextTurnInboxOptions {
	readonly home: string;
	readonly binding: PiSessionBinding;
	readonly now?: () => number;
	readonly claimLeaseMs?: number;
	readonly maxAttempts?: number;
}

const defaultClaimLeaseMs = 30_000;
const defaultMaxAttempts = 3;
const opaqueId =
	/^([a-z]+)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function nowIso(now: number): string {
	return new Date(now).toISOString();
}

function newOpaqueId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function requireOpaque(value: string, prefix: string, label: string): void {
	if (!opaqueId.test(value) || !value.toLowerCase().startsWith(`${prefix}_`))
		throw new Error(`pi.binding.${label}_invalid`);
}

function requireBinding(binding: PiSessionBinding): void {
	requireOpaque(binding.projectId, "prj", "project");
	requireOpaque(binding.sessionId, "ses", "session");
	requireOpaque(binding.generationId, "gen", "generation");
	requireOpaque(binding.endpointId, "ep", "endpoint");
	requireOpaque(binding.producerInstanceId, "prod", "producer");
	if (!/^[1-9][0-9]*$/u.test(binding.ownerFence))
		throw new Error("pi.binding.fence_invalid");
}

function safeFileName(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u.test(value))
		throw new Error("pi.next_turn.delivery_id_unsafe");
	return `${value}.json`;
}

/**
 * Error text from a harness, a remote API, or a malformed durable record is
 * hostile input.  It must never become durable diagnostic data.  Keep the
 * useful classification, but deliberately discard every caller-supplied byte
 * (including a plausible-but-not-yet-known secret format).
 */
function stableDiagnosticCategory(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (normalized === "processing_metadata_invalid")
		return "pi.next_turn.processing_metadata_invalid";
	if (normalized === "processing_lease_exhausted")
		return "pi.next_turn.processing_lease_exhausted";
	if (normalized === "pending_record_invalid")
		return "pi.next_turn.pending_record_invalid";
	if (normalized === "generation_or_fence_changed")
		return "pi.next_turn.generation_or_fence_changed";
	if (normalized === "ack_metadata_invalid")
		return "pi.next_turn.ack_metadata_invalid";
	if (/renderable|payload|turn text/iu.test(normalized))
		return "pi.next_turn.payload_unrenderable";
	if (/fence|generation|endpoint/iu.test(normalized))
		return "pi.next_turn.binding_changed";
	if (/lease|recover|retry/iu.test(normalized))
		return "pi.next_turn.recovery_failed";
	if (/record|metadata|parse|invalid/iu.test(normalized))
		return "pi.next_turn.record_invalid";
	return "pi.next_turn.delivery_failed";
}

function stableReference(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Runtime event metadata has no authority to carry free-form transcript text. */
function safeEventMetadata(
	metadata: Readonly<Record<string, string | number | boolean>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
	if (!metadata) return undefined;
	const sanitized: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (typeof value !== "string") {
			sanitized[key] = value;
			continue;
		}
		// A one-token label is useful in projection/UI diagnostics. Multi-word
		// values are treated as transcript-like and never persisted as an event.
		sanitized[key] = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value)
			? value
			: "[REDACTED]";
	}
	return Object.freeze(sanitized);
}

function safeWaitingReason(value: string | undefined): string {
	if (value === "pi_waiting" || value === "awaiting_user_input") return value;
	return "pi_waiting";
}

function fsyncDirectory(directory: string): void {
	const descriptor = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function writeAtomic(target: string, value: unknown): void {
	const temporary = `${target}.${crypto.randomUUID()}.tmp`;
	const descriptor = fs.openSync(
		temporary,
		fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
		0o600,
	);
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	fs.renameSync(temporary, target);
	fsyncDirectory(path.dirname(target));
}

function linkNoReplace(source: string, target: string): boolean {
	try {
		fs.linkSync(source, target);
		fsyncDirectory(path.dirname(target));
		return true;
	} catch (error) {
		if ((error as { readonly code?: string }).code === "EEXIST") return false;
		throw error;
	}
}

function count(directory: string, suffix = ".json"): number {
	return (
		fs.readdirSync(directory, { withFileTypes: true }) as readonly {
			readonly name: string;
			isFile(): boolean;
		}[]
	).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).length;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("pi.control.invalid_response");
	return value as Readonly<Record<string, unknown>>;
}

function textFromPayload(
	payload: Readonly<Record<string, unknown>>,
): string | undefined {
	for (const key of ["text", "brief", "body", "message"] as const) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/**
 * Converts Pi-native lifecycle facts to runtime signals.  It is stateful only
 * for producer sequence/deduplication; the canonical generation is supplied
 * by the launcher/runtime binding and cannot be guessed from a resume.
 */
export class PiLifecycleEmitter {
	readonly #binding: PiSessionBinding;
	#sequence = 0;

	constructor(binding: PiSessionBinding) {
		requireBinding(binding);
		this.#binding = Object.freeze({ ...binding });
	}

	#signal(
		kind: RuntimeSignalKind,
		payload: unknown,
		observedAt: string,
	): RuntimeSignalV1 {
		this.#sequence += 1;
		return RuntimeSignalV1Schema.parse({
			schema_version: "golem.runtime-signal/v1",
			event_id: newOpaqueId("evt"),
			event_kind: kind,
			producer: "golem-pi-adapter",
			producer_instance_id: this.#binding.producerInstanceId,
			harness: "pi",
			producer_sequence: this.#sequence,
			correlation_id: this.#binding.generationId,
			deduplication_key: `pi:${this.#binding.generationId}:${this.#sequence}:${kind}`,
			owner_fence: this.#binding.ownerFence,
			clocks: {
				source_observed_at: observedAt,
				received_at: observedAt,
			},
			provenance: {
				source: "adapter",
				evidence_id: this.#binding.generationId,
				confidence: "observed",
			},
			clear_fields: [],
			payload,
		});
	}

	emit(input: PiLifecycleInput): readonly RuntimeSignalV1[] {
		const observedAt = input.observedAt ?? new Date().toISOString();
		const metadata = safeEventMetadata(input.metadata);
		const generation = {
			project_id: this.#binding.projectId,
			session_id: this.#binding.sessionId,
			generation_id: this.#binding.generationId,
		};
		switch (input.event) {
			case "started":
				return Object.freeze([
					this.#signal(
						"session.started",
						{
							kind: "session.started",
							generation,
							...(metadata ? { metadata } : {}),
						},
						observedAt,
					),
					this.#signal(
						"endpoint.claimed",
						{
							kind: "endpoint.claimed",
							endpoint: {
								endpoint_id: this.#binding.endpointId,
								generation,
								state: "healthy",
								owner_fence: this.#binding.ownerFence,
								delivery_mode: "next_turn",
								readiness: "next_turn",
								revision: 1,
								last_heartbeat_at: observedAt,
							},
						},
						observedAt,
					),
					this.#signal(
						"capabilities.reported",
						{
							kind: "capabilities.reported",
							project: { project_id: this.#binding.projectId },
							capabilities: [
								{
									capability_id: "pi.next-turn.pull",
									harness: "pi",
									adapter_version: "5.1.1",
									integration_layers: ["extension"],
									qualification: "supported",
									delivery_mode: "next_turn",
									readiness: "next_turn",
									reason_code: "real_user_turn_required",
									evidence_version: "pi-next-turn-v1",
								},
							],
						},
						observedAt,
					),
				]);
			case "resumed":
				return Object.freeze([
					this.#signal(
						"session.resumed",
						{ kind: "session.resumed", generation },
						observedAt,
					),
				]);
			case "activity":
				return Object.freeze([
					this.#signal(
						"session.activity",
						{
							kind: "session.activity",
							generation,
							activity_kind: input.activityKind ?? "work",
						},
						observedAt,
					),
				]);
			case "idle":
				return Object.freeze([
					this.#signal(
						"session.idle",
						{ kind: "session.idle", generation },
						observedAt,
					),
				]);
			case "waiting":
				return Object.freeze([
					this.#signal(
						"session.waiting",
						{
							kind: "session.waiting",
							generation,
							reason: safeWaitingReason(input.waitingReason),
						},
						observedAt,
					),
				]);
			case "metadata":
				return Object.freeze([
					this.#signal(
						"session.metadata_patched",
						{
							kind: "session.metadata_patched",
							generation,
							metadata: metadata ?? {},
						},
						observedAt,
					),
				]);
			case "ended":
				return Object.freeze([
					this.#signal(
						"session.ended",
						{
							kind: "session.ended",
							generation,
							disposition: input.disposition ?? "ended",
						},
						observedAt,
					),
				]);
		}
	}
}

/** Typed API adapter; it has no storage or native transport authority. */
export function createPiControlApi(client: ApiClientBoundary): PiControlPort {
	function requireTrustedBinding(binding: PiSessionBinding): void {
		requireBinding(binding);
		if (
			client.caller.projectId !== binding.projectId ||
			client.caller.sessionId !== binding.sessionId
		)
			throw new Error("pi.control.caller_binding_required");
	}
	async function request(
		input: Parameters<ApiClientBoundary["request"]>[0],
	): Promise<Readonly<Record<string, unknown>>> {
		const response = await client.request(input);
		if (response.status < 200 || response.status >= 300)
			throw new Error(`pi.control.http_${response.status}`);
		return object(response.body);
	}
	function claimFrom(value: unknown): PiRemoteClaim {
		const row = object(value);
		if (
			typeof row.id !== "string" ||
			typeof row.claimToken !== "string" ||
			!row.payload ||
			typeof row.payload !== "object" ||
			Array.isArray(row.payload) ||
			!row.endpoint ||
			typeof row.endpoint !== "object" ||
			Array.isArray(row.endpoint)
		)
			throw new Error("pi.control.claim_invalid");
		return Object.freeze({
			deliveryId: row.id,
			claimToken: row.claimToken,
			payload: Object.freeze({ ...(row.payload as Record<string, unknown>) }),
			endpoint: Object.freeze({ ...(row.endpoint as Record<string, unknown>) }),
		});
	}
	const port: PiControlPort = {
		async ingest(signal: RuntimeSignalV1) {
			RuntimeSignalV1Schema.parse(signal);
			const result = await request({
				method: "POST",
				path: "/api/v1/runtime/events",
				body: signal,
			});
			if (result.schema_version !== "golem.runtime-ingest-receipt/v1")
				throw new Error("pi.control.runtime_receipt_invalid");
		},
		async claimNextTurn(input: {
			readonly binding: PiSessionBinding;
			readonly limit?: number;
			readonly leaseMs?: number;
		}) {
			requireTrustedBinding(input.binding);
			const result = await request({
				method: "POST",
				path: "/api/v1/delivery/claims",
				body: {
					worker_id: input.binding.sessionId,
					limit: input.limit ?? 1,
					...(input.leaseMs === undefined ? {} : { lease_ms: input.leaseMs }),
				},
			});
			if (!Array.isArray(result.items))
				throw new Error("pi.control.claim_page_invalid");
			return Object.freeze(result.items.map(claimFrom));
		},
		async prepare(claimToken: string) {
			const response = await client.request({
				method: "POST",
				path: `/api/v1/delivery/claims/${encodeURIComponent(claimToken)}/prepare`,
			});
			if (response.status !== 200 && response.status !== 409)
				throw new Error(`pi.control.http_${response.status}`);
			const result = object(response.body);
			const prepared = object(result.result);
			if (prepared.kind === "stale") {
				const reason = prepared.reason;
				if (reason !== "endpoint_changed" && reason !== "ineligible")
					throw new Error("pi.control.prepare_invalid");
				return Object.freeze({ kind: "stale", reason });
			}
			if (prepared.kind !== "deliver")
				throw new Error("pi.control.prepare_invalid");
			return Object.freeze({
				kind: "deliver",
				claim: claimFrom(prepared.envelope),
			});
		},
		async acknowledge(input: {
			readonly claimToken: string;
			readonly acknowledgementId: string;
			readonly payload?: Readonly<Record<string, unknown>>;
		}) {
			await request({
				method: "POST",
				path: `/api/v1/delivery/claims/${encodeURIComponent(input.claimToken)}/ack`,
				body: {
					acknowledgement_id: input.acknowledgementId,
					...(input.payload === undefined ? {} : { payload: input.payload }),
				},
			});
		},
		async delivered(claimToken: string) {
			await request({
				method: "POST",
				path: `/api/v1/delivery/claims/${encodeURIComponent(claimToken)}/delivered`,
			});
		},
		async fail(input: { readonly claimToken: string; readonly error: string }) {
			await request({
				method: "POST",
				path: `/api/v1/delivery/claims/${encodeURIComponent(input.claimToken)}/fail`,
				body: { error: stableDiagnosticCategory(input.error) },
			});
		},
	};
	return Object.freeze(port);
}

interface PiStoredTurn extends PiQueuedTurn {
	readonly schema_version: "golem.pi-next-turn/v1";
	readonly binding: Readonly<{
		project_id: string;
		session_id: string;
		generation_id: string;
		endpoint_id: string;
		owner_fence: string;
	}>;
	readonly created_at: string;
}

interface PiLease {
	readonly attempt: number;
	readonly claimed_at: number;
	readonly lease_ms: number;
}

function parseStored(value: unknown): PiStoredTurn {
	const row = object(value);
	const binding = object(row.binding);
	if (
		row.schema_version !== "golem.pi-next-turn/v1" ||
		typeof row.deliveryId !== "string" ||
		typeof row.claimToken !== "string" ||
		typeof row.text !== "string" ||
		typeof row.created_at !== "string" ||
		typeof binding.project_id !== "string" ||
		typeof binding.session_id !== "string" ||
		typeof binding.generation_id !== "string" ||
		typeof binding.endpoint_id !== "string" ||
		typeof binding.owner_fence !== "string"
	)
		throw new Error("pi.next_turn.record_invalid");
	return row as unknown as PiStoredTurn;
}

function parseLease(value: unknown): PiLease {
	const row = object(value);
	if (
		!Number.isInteger(row.attempt) ||
		(row.attempt as number) < 1 ||
		typeof row.claimed_at !== "number" ||
		typeof row.lease_ms !== "number" ||
		(row.lease_ms as number) < 1
	)
		throw new Error("pi.next_turn.lease_invalid");
	return row as unknown as PiLease;
}

/**
 * Local transport for a claimed next-turn delivery. It uses immutable published
 * bytes plus link/rename transitions, so producer replay and a killed Pi
 * extension cannot replace a message that a real turn has already claimed.
 */
export class PiNextTurnInbox {
	readonly #binding: PiSessionBinding;
	readonly #root: string;
	readonly #published: string;
	readonly #pending: string;
	readonly #processing: string;
	readonly #acks: string;
	readonly #deadLetters: string;
	readonly #retry: string;
	readonly #now: () => number;
	readonly #leaseMs: number;
	readonly #maxAttempts: number;

	constructor(options: PiNextTurnInboxOptions) {
		requireBinding(options.binding);
		this.#binding = Object.freeze({ ...options.binding });
		this.#root = path.join(
			options.home,
			"pi-next-turn",
			this.#binding.sessionId,
			this.#binding.generationId,
		);
		this.#published = path.join(this.#root, "published");
		this.#pending = path.join(this.#root, "pending");
		this.#processing = path.join(this.#root, "processing");
		this.#acks = path.join(this.#root, "acks");
		this.#deadLetters = path.join(this.#root, "dead-letter");
		this.#retry = path.join(this.#root, "retry");
		for (const directory of [
			this.#published,
			this.#pending,
			this.#processing,
			this.#acks,
			this.#deadLetters,
			this.#retry,
		])
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.#now = options.now ?? Date.now;
		this.#leaseMs = options.claimLeaseMs ?? defaultClaimLeaseMs;
		this.#maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
		if (!Number.isInteger(this.#leaseMs) || this.#leaseMs < 1)
			throw new Error("pi.next_turn.lease_invalid");
		if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1)
			throw new Error("pi.next_turn.max_attempts_invalid");
	}

	get root(): string {
		return this.#root;
	}

	stage(turn: PiQueuedTurn): "staged" | "already_staged" {
		const name = safeFileName(turn.deliveryId);
		const published = path.join(this.#published, name);
		const pending = path.join(this.#pending, name);
		const existed = fs.existsSync(published);
		if (!existed) {
			const candidate = path.join(
				this.#published,
				`.${name}.${crypto.randomUUID()}.tmp`,
			);
			const record: PiStoredTurn = Object.freeze({
				schema_version: "golem.pi-next-turn/v1",
				deliveryId: turn.deliveryId,
				claimToken: turn.claimToken,
				text: turn.text,
				binding: Object.freeze({
					project_id: this.#binding.projectId,
					session_id: this.#binding.sessionId,
					generation_id: this.#binding.generationId,
					endpoint_id: this.#binding.endpointId,
					owner_fence: this.#binding.ownerFence,
				}),
				created_at: nowIso(this.#now()),
			});
			writeAtomic(candidate, record);
			try {
				if (!linkNoReplace(candidate, published)) {
					const prior = parseStored(
						JSON.parse(fs.readFileSync(published, "utf8")),
					);
					if (prior.claimToken !== turn.claimToken || prior.text !== turn.text)
						throw new Error("pi.next_turn.delivery_conflict");
				}
			} finally {
				if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
			}
		}
		const inFlight = [
			path.join(this.#processing, name),
			path.join(this.#acks, name),
			path.join(this.#published, `${name}.settled`),
		].some((candidate) => fs.existsSync(candidate));
		if (!fs.existsSync(pending) && !inFlight) linkNoReplace(published, pending);
		return existed ? "already_staged" : "staged";
	}

	#leasePath(directory: string, deliveryId: string): string {
		return path.join(directory, `${safeFileName(deliveryId)}.lease.json`);
	}

	#retryPath(deliveryId: string): string {
		return path.join(this.#retry, safeFileName(deliveryId));
	}

	#readRetry(
		deliveryId: string,
	):
		| { readonly attempts: number; readonly next_attempt_at: number }
		| undefined {
		const candidate = this.#retryPath(deliveryId);
		if (!fs.existsSync(candidate)) return undefined;
		try {
			const row = object(JSON.parse(fs.readFileSync(candidate, "utf8")));
			if (
				!Number.isInteger(row.attempts) ||
				(row.attempts as number) < 1 ||
				typeof row.next_attempt_at !== "number"
			)
				throw new Error("invalid retry");
			return {
				attempts: row.attempts as number,
				next_attempt_at: row.next_attempt_at,
			};
		} catch {
			return undefined;
		}
	}

	#clearRetry(deliveryId: string): void {
		const candidate = this.#retryPath(deliveryId);
		if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
	}

	recover(): { readonly reclaimed: number; readonly deadLettered: number } {
		let reclaimed = 0;
		let deadLettered = 0;
		for (const entry of fs.readdirSync(this.#processing, {
			withFileTypes: true,
		}) as readonly { readonly name: string; isFile(): boolean }[]) {
			if (
				!entry.isFile() ||
				!entry.name.endsWith(".json") ||
				entry.name.endsWith(".lease.json")
			)
				continue;
			const source = path.join(this.#processing, entry.name);
			let stored: PiStoredTurn;
			let lease: PiLease;
			try {
				stored = parseStored(JSON.parse(fs.readFileSync(source, "utf8")));
				lease = parseLease(
					JSON.parse(
						fs.readFileSync(
							this.#leasePath(this.#processing, stored.deliveryId),
							"utf8",
						),
					),
				);
			} catch {
				this.#deadLetter(source, "processing_metadata_invalid", 1);
				deadLettered += 1;
				continue;
			}
			if (lease.claimed_at + lease.lease_ms > this.#now()) continue;
			if (lease.attempt >= this.#maxAttempts) {
				this.#deadLetter(source, "processing_lease_exhausted", lease.attempt);
				deadLettered += 1;
				continue;
			}
			linkNoReplace(
				source,
				path.join(this.#pending, safeFileName(stored.deliveryId)),
			);
			fs.unlinkSync(source);
			const leasePath = this.#leasePath(this.#processing, stored.deliveryId);
			if (fs.existsSync(leasePath)) fs.unlinkSync(leasePath);
			writeAtomic(this.#retryPath(stored.deliveryId), {
				attempts: lease.attempt,
				next_attempt_at: this.#now(),
			});
			reclaimed += 1;
		}
		return Object.freeze({ reclaimed, deadLettered });
	}

	claimForRealUserTurn(limit = 1): readonly PiClaimedTurn[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 10)
			throw new Error("pi.next_turn.claim_limit_invalid");
		this.recover();
		const claimed: PiClaimedTurn[] = [];
		const entries = fs.readdirSync(this.#pending, {
			withFileTypes: true,
		}) as readonly { readonly name: string; isFile(): boolean }[];
		for (const entry of [...entries].sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (
				claimed.length >= limit ||
				!entry.isFile() ||
				!entry.name.endsWith(".json")
			)
				continue;
			const source = path.join(this.#pending, entry.name);
			let stored: PiStoredTurn;
			try {
				stored = parseStored(JSON.parse(fs.readFileSync(source, "utf8")));
			} catch {
				this.#deadLetter(source, "pending_record_invalid", 1);
				continue;
			}
			if (
				stored.binding.generation_id !== this.#binding.generationId ||
				stored.binding.owner_fence !== this.#binding.ownerFence
			) {
				this.#deadLetter(source, "generation_or_fence_changed", 1);
				continue;
			}
			const retry = this.#readRetry(stored.deliveryId);
			if (retry && retry.next_attempt_at > this.#now()) continue;
			const target = path.join(this.#processing, entry.name);
			try {
				fs.renameSync(source, target);
				fsyncDirectory(this.#pending);
				fsyncDirectory(this.#processing);
			} catch (error) {
				if ((error as { readonly code?: string }).code === "ENOENT") continue;
				throw error;
			}
			const attempt = (retry?.attempts ?? 0) + 1;
			writeAtomic(this.#leasePath(this.#processing, stored.deliveryId), {
				attempt,
				claimed_at: this.#now(),
				lease_ms: this.#leaseMs,
			});
			claimed.push(
				Object.freeze({
					deliveryId: stored.deliveryId,
					claimToken: stored.claimToken,
					text: stored.text,
					attempt,
				}),
			);
		}
		return Object.freeze(claimed);
	}

	acknowledgeTurn(turn: PiClaimedTurn): PiPendingAcknowledgement {
		const name = safeFileName(turn.deliveryId);
		const source = path.join(this.#processing, name);
		const target = path.join(this.#acks, name);
		if (!fs.existsSync(source)) throw new Error("pi.next_turn.claim_missing");
		fs.renameSync(source, target);
		const lease = this.#leasePath(this.#processing, turn.deliveryId);
		if (fs.existsSync(lease)) fs.unlinkSync(lease);
		const acknowledgementId = newOpaqueId("del");
		writeAtomic(this.#leasePath(this.#acks, turn.deliveryId), {
			acknowledgement_id: acknowledgementId,
			claim_token: turn.claimToken,
		});
		return Object.freeze({ ...turn, acknowledgementId });
	}

	pendingAcknowledgements(): readonly PiPendingAcknowledgement[] {
		const values: PiPendingAcknowledgement[] = [];
		for (const entry of fs.readdirSync(this.#acks, {
			withFileTypes: true,
		}) as readonly { readonly name: string; isFile(): boolean }[]) {
			if (
				!entry.isFile() ||
				!entry.name.endsWith(".json") ||
				entry.name.endsWith(".lease.json")
			)
				continue;
			try {
				const stored = parseStored(
					JSON.parse(
						fs.readFileSync(path.join(this.#acks, entry.name), "utf8"),
					),
				);
				const acknowledgement = object(
					JSON.parse(
						fs.readFileSync(
							this.#leasePath(this.#acks, stored.deliveryId),
							"utf8",
						),
					),
				);
				if (
					typeof acknowledgement.acknowledgement_id !== "string" ||
					typeof acknowledgement.claim_token !== "string"
				)
					throw new Error("ack invalid");
				values.push(
					Object.freeze({
						deliveryId: stored.deliveryId,
						claimToken: acknowledgement.claim_token,
						text: stored.text,
						acknowledgementId: acknowledgement.acknowledgement_id,
					}),
				);
			} catch {
				this.#deadLetter(
					path.join(this.#acks, entry.name),
					"ack_metadata_invalid",
					1,
				);
			}
		}
		return Object.freeze(values);
	}

	settleAcknowledgement(ack: PiPendingAcknowledgement): void {
		const source = path.join(this.#acks, safeFileName(ack.deliveryId));
		if (!fs.existsSync(source)) return;
		const target = path.join(
			this.#published,
			`${safeFileName(ack.deliveryId)}.settled`,
		);
		if (!fs.existsSync(target)) linkNoReplace(source, target);
		fs.unlinkSync(source);
		const metadata = this.#leasePath(this.#acks, ack.deliveryId);
		if (fs.existsSync(metadata)) fs.unlinkSync(metadata);
		this.#clearRetry(ack.deliveryId);
	}

	deadLetterClaim(turn: PiClaimedTurn, reason: string): void {
		this.#deadLetter(
			path.join(this.#processing, safeFileName(turn.deliveryId)),
			reason,
			turn.attempt,
		);
	}

	#deadLetter(source: string, reason: string, attempt: number): void {
		if (!fs.existsSync(source)) return;
		const base = path.basename(source, ".json");
		const category = stableDiagnosticCategory(reason);
		const deliveryReference = stableReference(base);
		const target = path.join(
			this.#deadLetters,
			`${deliveryReference}.${crypto.randomUUID()}.json`,
		);
		// A dead letter is evidence of a failed delivery, not a second durable
		// copy of a user prompt or bearer claim token.  Persist only a stable
		// category and a one-way delivery reference before dropping the raw row.
		writeAtomic(target, {
			schema_version: "golem.pi-next-turn-dead-letter/v1",
			delivery_reference: deliveryReference,
			reason: category,
			attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
		});
		fs.unlinkSync(source);
		const published = path.join(this.#published, `${base}.json`);
		if (fs.existsSync(published)) fs.unlinkSync(published);
		const settled = path.join(this.#published, `${base}.json.settled`);
		if (fs.existsSync(settled)) fs.unlinkSync(settled);
		this.#clearRetry(base);
		for (const directory of [this.#processing, this.#acks]) {
			const metadata = path.join(directory, `${base}.json.lease.json`);
			if (fs.existsSync(metadata)) fs.unlinkSync(metadata);
		}
	}

	diagnostics(): PiNextTurnDiagnostics {
		return Object.freeze({
			pending: count(this.#pending),
			processing:
				count(this.#processing) - count(this.#processing, ".lease.json"),
			acknowledgements: count(this.#acks) - count(this.#acks, ".lease.json"),
			deadLetters: count(this.#deadLetters),
			retrying: count(this.#retry),
		});
	}
}

/**
 * The only API pull entrypoint. Calling it is itself evidence of a real user
 * turn; there is intentionally no timer, heartbeat, or push helper here.
 */
export async function pullForRealUserTurn(input: {
	readonly control: PiControlPort;
	readonly inbox: PiNextTurnInbox;
	readonly binding: PiSessionBinding;
	readonly limit?: number;
}): Promise<readonly PiClaimedTurn[]> {
	requireBinding(input.binding);
	const claimed = await input.control.claimNextTurn({
		binding: input.binding,
		limit: input.limit ?? 1,
	});
	for (const remote of claimed) {
		const prepared = await input.control.prepare(remote.claimToken);
		if (prepared.kind === "stale") continue;
		const text = textFromPayload(prepared.claim.payload);
		if (!text) {
			await input.control.fail({
				claimToken: remote.claimToken,
				error: "Pi next-turn delivery has no renderable turn text",
			});
			continue;
		}
		input.inbox.stage({
			deliveryId: prepared.claim.deliveryId,
			claimToken: prepared.claim.claimToken,
			text,
		});
	}
	return input.inbox.claimForRealUserTurn(input.limit ?? 1);
}

/** Settle only after Pi actually starts work for the user turn. */
export async function settleAfterPiAgentStart(input: {
	readonly control: PiControlPort;
	readonly inbox: PiNextTurnInbox;
	readonly turns: readonly PiClaimedTurn[];
}): Promise<void> {
	for (const turn of input.turns) input.inbox.acknowledgeTurn(turn);
	for (const acknowledgement of input.inbox.pendingAcknowledgements()) {
		await input.control.acknowledge({
			claimToken: acknowledgement.claimToken,
			acknowledgementId: acknowledgement.acknowledgementId,
			payload: { delivery_mode: "next_turn", result: "pi_agent_started" },
		});
		// `ack` is the terminal, idempotent delivery settlement in the typed
		// service. Calling `/delivered` afterwards would race that terminal CAS
		// and turn a successful Pi turn into a spurious failure.
		input.inbox.settleAcknowledgement(acknowledgement);
	}
}

/**
 * Compatibility is deliberately import-only.  An old file becomes canonical
 * only when it carries the exact project/session/generation/endpoint/fence
 * binding; old names, PIDs, and bare Pi session ids remain diagnostics.
 */
export function importLegacyPiInbox(input: {
	readonly home: string;
	readonly legacySessionId: string;
	readonly binding: PiSessionBinding;
	readonly inbox: PiNextTurnInbox;
}): {
	readonly imported: readonly string[];
	readonly ambiguous: readonly string[];
} {
	requireBinding(input.binding);
	const key = safeFileName(input.legacySessionId).slice(0, -".json".length);
	const pending = path.join(input.home, "pi-inbox", key, "pending");
	if (!fs.existsSync(pending))
		return Object.freeze({
			imported: Object.freeze([]),
			ambiguous: Object.freeze([]),
		});
	const imported: string[] = [];
	const ambiguous: string[] = [];
	for (const entry of fs.readdirSync(pending, {
		withFileTypes: true,
	}) as readonly {
		readonly name: string;
		isFile(): boolean;
	}[]) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const legacyId = entry.name.slice(0, -".json".length);
		try {
			const row = object(
				JSON.parse(fs.readFileSync(path.join(pending, entry.name), "utf8")),
			);
			const metadata = object(row.metadata);
			const binding = object(metadata.canonical_binding);
			if (
				typeof row.message_id !== "string" ||
				typeof row.text !== "string" ||
				typeof metadata.claim_token !== "string" ||
				binding.project_id !== input.binding.projectId ||
				binding.session_id !== input.binding.sessionId ||
				binding.generation_id !== input.binding.generationId ||
				binding.endpoint_id !== input.binding.endpointId ||
				binding.owner_fence !== input.binding.ownerFence
			) {
				ambiguous.push(legacyId);
				continue;
			}
			input.inbox.stage({
				deliveryId: row.message_id,
				claimToken: metadata.claim_token,
				text: row.text,
			});
			imported.push(row.message_id);
		} catch {
			ambiguous.push(legacyId);
		}
	}
	return Object.freeze({
		imported: Object.freeze(imported.sort()),
		ambiguous: Object.freeze(ambiguous.sort()),
	});
}
