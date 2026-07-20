import {
	RuntimeSignalKinds,
	type RuntimeSignalV1,
	RuntimeSignalV1Schema,
} from "@golem/contracts";
import type {
	PersistenceWriteCapability,
	RuntimeCanonicalMutation,
	RuntimeMaterializationResult,
} from "@golem/persistence";

import {
	type ClaimedInboxEntry,
	RuntimeInbox,
	type RuntimeInboxOptions,
} from "./inbox.js";

export interface RuntimeMaterializerHandlerResult {
	readonly disposition: "accepted" | "illegal";
	readonly explanation: {
		readonly code: string;
		readonly details: Readonly<Record<string, unknown>>;
	};
	readonly mutation?: RuntimeCanonicalMutation;
	readonly outbox?: {
		readonly destination: "tracker" | "management";
		readonly payload: Readonly<Record<string, unknown>>;
	};
}

export interface RuntimeMaterializerHandler {
	readonly kinds: readonly RuntimeSignalV1["event_kind"][];
	materialize(signal: RuntimeSignalV1): RuntimeMaterializerHandlerResult;
}

export interface MaterializerDrainResult {
	readonly reclaimed: number;
	readonly claimed: number;
	readonly materialized: number;
	readonly duplicated: number;
	readonly stale: number;
	readonly illegal: number;
	readonly quarantined: number;
	readonly retrying: number;
}

export type MaterializerFailpoint =
	| "after_claim"
	| "before_transaction"
	| "after_commit"
	| "before_archive";

function defaultHandler(
	signal: RuntimeSignalV1,
): RuntimeMaterializerHandlerResult {
	const outbox = {
		destination: "tracker" as const,
		payload: {
			event_id: signal.event_id,
			event_kind: signal.event_kind,
			producer_instance_id: signal.producer_instance_id,
		},
	};
	if (signal.payload.kind === "project.observed") {
		return Object.freeze({
			disposition: "accepted",
			explanation: {
				code: "runtime.project_observed",
				details: { event_kind: signal.event_kind },
			},
			mutation: {
				project: {
					projectId: signal.payload.project.project_id,
					name: signal.payload.project.project_id,
					locationId: signal.payload.location.location_id,
					canonicalPath: signal.payload.location.canonical_path,
					...(signal.payload.location.observed_path === undefined
						? {}
						: { observedPath: signal.payload.location.observed_path }),
					relation: signal.payload.location.relation,
				},
			},
			outbox,
		});
	}
	return Object.freeze({
		disposition: "accepted",
		explanation: {
			code: "runtime.signal_recorded",
			details: { event_kind: signal.event_kind },
		},
		outbox,
	});
}

/** The only handler registry currently required is deliberately pure. */
export function createDefaultRuntimeHandlers(): readonly RuntimeMaterializerHandler[] {
	return Object.freeze([
		Object.freeze({
			kinds: RuntimeSignalKinds,
			materialize: defaultHandler,
		}),
	]);
}

export class RuntimeMaterializer {
	readonly #inbox: RuntimeInbox;
	readonly #writer: PersistenceWriteCapability;
	readonly #handlers: ReadonlyMap<string, RuntimeMaterializerHandler>;

	constructor(options: {
		readonly inbox: RuntimeInbox;
		readonly writer: PersistenceWriteCapability;
		readonly handlers?: readonly RuntimeMaterializerHandler[];
	}) {
		this.#inbox = options.inbox;
		this.#writer = options.writer;
		const handlers = new Map<string, RuntimeMaterializerHandler>();
		for (const handler of options.handlers ?? createDefaultRuntimeHandlers())
			for (const kind of handler.kinds) {
				if (handlers.has(kind))
					throw new Error(`runtime materializer duplicate handler: ${kind}`);
				handlers.set(kind, handler);
			}
		this.#handlers = handlers;
	}

	get inbox(): RuntimeInbox {
		return this.#inbox;
	}

	drain(
		options: {
			readonly limit?: number;
			readonly failpoint?: MaterializerFailpoint;
		} = {},
	): MaterializerDrainResult {
		const reclaimed = this.#inbox.reclaimProcessing();
		const claimed = this.#inbox.claim(options.limit ?? 100);
		const result = {
			reclaimed,
			claimed: claimed.length,
			materialized: 0,
			duplicated: 0,
			stale: 0,
			illegal: 0,
			quarantined: 0,
			retrying: 0,
		};
		for (const entry of claimed) {
			if (options.failpoint === "after_claim")
				throw new Error("runtime materializer failpoint after_claim");
			const outcome = this.#materializeClaim(entry, options.failpoint);
			result[outcome] += 1;
		}
		return Object.freeze(result);
	}

	#materializeClaim(
		entry: ClaimedInboxEntry,
		failpoint: MaterializerFailpoint | undefined,
	):
		| "materialized"
		| "duplicated"
		| "stale"
		| "illegal"
		| "quarantined"
		| "retrying" {
		if (entry.raw.byteLength > 1_048_576) {
			this.#inbox.quarantine(entry, "oversized");
			return "quarantined";
		}
		let decoded: unknown;
		try {
			decoded = JSON.parse(Buffer.from(entry.raw).toString("utf8"));
		} catch {
			this.#inbox.quarantine(entry, "malformed_json");
			return "quarantined";
		}
		const parsed = RuntimeSignalV1Schema.safeParse(decoded);
		if (!parsed.success) {
			this.#inbox.quarantine(entry, "unsupported_or_invalid_schema");
			return "quarantined";
		}
		const handler = this.#handlers.get(parsed.data.event_kind);
		if (!handler) {
			this.#inbox.quarantine(entry, "unregistered_event_kind");
			return "quarantined";
		}
		if (failpoint === "before_transaction")
			throw new Error("runtime materializer failpoint before_transaction");
		let outcome: RuntimeMaterializationResult;
		try {
			const decision = handler.materialize(parsed.data);
			outcome = this.#writer.materializeRuntimeEvent({
				eventId: parsed.data.event_id,
				deduplicationKey: parsed.data.deduplication_key,
				eventKind: parsed.data.event_kind,
				payload: parsed.data.payload,
				provenance: parsed.data.provenance,
				occurredAt: parsed.data.clocks.source_observed_at,
				producer: {
					id: parsed.data.producer_instance_id,
					...(parsed.data.producer_sequence === undefined
						? {}
						: { sequence: parsed.data.producer_sequence }),
				},
				disposition: decision.disposition,
				explanation: decision.explanation,
				...(decision.mutation ? { mutation: decision.mutation } : {}),
				...(decision.outbox ? { outbox: decision.outbox } : {}),
			});
		} catch (error) {
			const retry = this.#inbox.retry(
				entry,
				error instanceof Error ? error.message : String(error),
			);
			return retry;
		}
		if (failpoint === "after_commit")
			throw new Error("runtime materializer failpoint after_commit");
		if (failpoint === "before_archive")
			throw new Error("runtime materializer failpoint before_archive");
		this.#inbox.archive(entry);
		switch (outcome.disposition) {
			case "accepted":
				return "materialized";
			case "duplicate":
				return "duplicated";
			case "stale":
				return "stale";
			case "illegal":
				return "illegal";
		}
	}
}

export function createRuntimeMaterializer(options: {
	readonly home: string;
	readonly writer: PersistenceWriteCapability;
	readonly handlers?: readonly RuntimeMaterializerHandler[];
	readonly inboxOptions?: RuntimeInboxOptions;
}): {
	readonly inbox: RuntimeInbox;
	readonly materializer: RuntimeMaterializer;
} {
	const inbox = new RuntimeInbox(options.home, options.inboxOptions);
	return Object.freeze({
		inbox,
		materializer: new RuntimeMaterializer({
			inbox,
			writer: options.writer,
			...(options.handlers ? { handlers: options.handlers } : {}),
		}),
	});
}
