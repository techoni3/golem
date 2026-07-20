import type {
	PersistenceWriteCapability,
	RuntimeOutboxHealth,
} from "@golem/persistence";

import type { RuntimeInboxMetrics } from "./inbox.js";
import type {
	MaterializerDrainResult,
	RuntimeMaterializer,
} from "./materializer.js";
import type {
	RuntimeOutboxDrainer,
	RuntimeOutboxDrainResult,
} from "./outbox.js";

export interface RuntimeEngineHealth {
	readonly inbox: RuntimeInboxMetrics;
	readonly outbox: RuntimeOutboxHealth;
	readonly lastSuccessfulMaterializationAt?: string;
	readonly lastTickError?: string;
}

export interface RuntimeEngineTick {
	readonly materializer: MaterializerDrainResult;
	readonly outbox: RuntimeOutboxDrainResult;
}

/**
 * The service lifecycle owns this bounded scheduler. It runs both durable
 * queues, never overlaps a tick, and exposes payload-free health facts.
 */
export class RuntimeEngineScheduler {
	readonly #materializer: RuntimeMaterializer;
	readonly #outbox: RuntimeOutboxDrainer;
	readonly #writer: PersistenceWriteCapability;
	readonly #intervalMs: number;
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<RuntimeEngineTick> | undefined;
	#lastSuccessfulMaterializationAt: string | undefined;
	#lastTickError: string | undefined;

	constructor(options: {
		readonly materializer: RuntimeMaterializer;
		readonly outbox: RuntimeOutboxDrainer;
		readonly writer: PersistenceWriteCapability;
		readonly intervalMs?: number;
	}) {
		this.#materializer = options.materializer;
		this.#outbox = options.outbox;
		this.#writer = options.writer;
		this.#intervalMs = options.intervalMs ?? 250;
		if (!Number.isInteger(this.#intervalMs) || this.#intervalMs < 25)
			throw new Error(
				"runtime scheduler interval must be an integer of at least 25ms",
			);
	}

	async start(): Promise<RuntimeEngineTick> {
		if (this.#timer) throw new Error("runtime scheduler is already running");
		const initial = await this.tick();
		this.#timer = setInterval(() => {
			void this.tick().catch(() => undefined);
		}, this.#intervalMs);
		return initial;
	}

	async tick(): Promise<RuntimeEngineTick> {
		if (this.#running) return this.#running;
		const running = (async () => {
			try {
				const materializer = this.#materializer.drain();
				const outbox = await this.#outbox.drain();
				if (materializer.materialized > 0 || materializer.duplicated > 0)
					this.#lastSuccessfulMaterializationAt = new Date().toISOString();
				this.#lastTickError = undefined;
				return Object.freeze({ materializer, outbox });
			} catch (error) {
				// Error payloads can carry destination credentials. Health needs only a
				// bounded operational fact; durable redacted diagnostics stay in SQLite.
				this.#lastTickError = "runtime tick deferred";
				throw error;
			} finally {
				this.#running = undefined;
			}
		})();
		this.#running = running;
		return running;
	}

	async stop(): Promise<void> {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (this.#running) await this.#running.catch(() => undefined);
	}

	health(): RuntimeEngineHealth {
		return Object.freeze({
			inbox: this.#materializer.inbox.metrics(),
			outbox: this.#writer.runtimeOutboxHealth(),
			...(this.#lastSuccessfulMaterializationAt
				? {
						lastSuccessfulMaterializationAt:
							this.#lastSuccessfulMaterializationAt,
					}
				: {}),
			...(this.#lastTickError ? { lastTickError: this.#lastTickError } : {}),
		});
	}
}
