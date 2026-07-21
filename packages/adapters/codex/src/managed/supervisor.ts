import type { RuntimeSignalV1 } from "@golem/contracts";
import {
	type ManagedCodexQualification,
	ManagedCodexQualificationError,
	managedCodexSignal,
	qualifyManagedCodex,
} from "./policy.js";
import { ManagedCodexRpc, type ManagedCodexRpcOptions } from "./rpc.js";

export interface ManagedCodexEndpointEligibility {
	readonly disposition: "eligible" | "ineligible";
	readonly code: string;
	readonly remedy?: string;
}

export interface ManagedCodexEndpointPort {
	claim(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	eligibility(
		input: Readonly<Record<string, unknown>>,
	): Promise<ManagedCodexEndpointEligibility> | ManagedCodexEndpointEligibility;
	reportReadiness?(
		input: Readonly<Record<string, unknown>>,
	): Promise<unknown> | unknown;
	probe?(input: Readonly<Record<string, unknown>>): Promise<unknown> | unknown;
	reportCapability?(
		input: Readonly<Record<string, unknown>>,
	): Promise<unknown> | unknown;
	reportHealth?(
		input: Readonly<Record<string, unknown>>,
	): Promise<unknown> | unknown;
	reportDelivery?(
		input: Readonly<Record<string, unknown>>,
	): Promise<unknown> | unknown;
	release?(
		input: Readonly<Record<string, unknown>>,
	): Promise<unknown> | unknown;
}

export interface ManagedCodexIngress {
	ingest(signal: RuntimeSignalV1): Promise<unknown> | unknown;
}

export interface ManagedCodexDeliveryPort {
	/**
	 * A supervisor never invents an accepted claim from process-local state.
	 * The control-plane composition supplies a fence-checked durable envelope
	 * claim, and a restarted supervisor receives a fresh instance of that claim.
	 */
	claim(
		input: Readonly<Record<string, unknown>>,
	): Promise<Readonly<Record<string, unknown>>>;
	/**
	 * Records the accepted delivery in the canonical durable port before the
	 * App Server process boundary. A restarted supervisor must therefore not
	 * reclaim an envelope after a successful `turn/start` but before ack.
	 */
	markSent(input: Readonly<Record<string, unknown>>): Promise<unknown>;
	ack(input: Readonly<Record<string, unknown>>): Promise<unknown>;
	fail(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ManagedCodexBinding {
	readonly projectId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly endpointId: string;
	readonly ownerInstanceId: string;
	readonly ownerFence?: number;
	readonly producerInstanceId: string;
}

export interface ManagedCodexSupervisorOptions {
	readonly binding: ManagedCodexBinding;
	readonly projectPath: string;
	readonly backend?: string;
	readonly model?: string;
	readonly command?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly rpc?: Omit<
		ManagedCodexRpcOptions,
		"cwd" | "command" | "env" | "onExit"
	>;
	readonly endpoints: ManagedCodexEndpointPort;
	readonly ingress: ManagedCodexIngress;
	readonly delivery?: ManagedCodexDeliveryPort;
	readonly now?: () => string;
}

export interface ManagedCodexStartResult {
	readonly launchable: true;
	readonly deliveryReady: boolean;
	readonly resumed: boolean;
	readonly threadId: string;
	readonly endpointId: string;
	readonly ownerFence?: number;
	readonly qualification: ManagedCodexQualification;
}

export interface ManagedCodexDeliveryInput {
	readonly deliveryId: string;
	readonly text: string;
	readonly expectedOwnerFence?: number;
	/**
	 * The queue worker supplies the claim for this particular envelope. It must
	 * not be cached by the supervisor because the lease belongs to persistence.
	 */
	readonly delivery?: ManagedCodexDeliveryPort;
}

export interface ManagedCodexDeliveryResult {
	readonly status: "accepted" | "duplicate" | "rejected" | "retry";
	readonly code: string;
	readonly deliveryId: string;
	readonly turnId?: string;
}

function nowIso(now: () => string): string {
	const parsed = new Date(now());
	return Number.isNaN(parsed.valueOf())
		? new Date(0).toISOString()
		: parsed.toISOString();
}

function recordString(
	record: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value ? value : undefined;
}

function recordNumber(
	record: Readonly<Record<string, unknown>>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Canonical managed Codex supervisor. Persistence, endpoint ownership, and
 * delivery settlement are injected by the control-plane composition; this
 * package owns only App Server protocol and typed signal translation.
 */
export class ManagedCodexSupervisor {
	readonly #options: ManagedCodexSupervisorOptions;
	readonly #qualification: ManagedCodexQualification;
	readonly #now: () => string;
	#rpc: ManagedCodexRpc | undefined;
	#threadId: string | undefined;
	#ownerFence: number | undefined;
	#sequence = 0;
	#capabilitySequence = 0;
	#started = false;

	constructor(options: ManagedCodexSupervisorOptions) {
		this.#options = options;
		this.#qualification = qualifyManagedCodex({
			...(options.backend === undefined ? {} : { backend: options.backend }),
			...(options.model === undefined ? {} : { model: options.model }),
		});
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	get qualification(): ManagedCodexQualification {
		return this.#qualification;
	}
	get threadId(): string | undefined {
		return this.#threadId;
	}
	get ownerFence(): number | undefined {
		return this.#ownerFence;
	}

	async #emit(
		kind: RuntimeSignalV1["event_kind"],
		payload?: Readonly<Record<string, unknown>>,
	): Promise<void> {
		this.#sequence += 1;
		await this.#options.ingress.ingest(
			managedCodexSignal({
				kind,
				projectId: this.#options.binding.projectId,
				sessionId: this.#options.binding.sessionId,
				generationId: this.#options.binding.generationId,
				producerInstanceId: this.#options.binding.producerInstanceId,
				observedAt: nowIso(this.#now),
				sequence: this.#sequence,
				...(payload ? { payload } : {}),
			}),
		);
	}

	#handleNotification(message: Readonly<Record<string, unknown>>): void {
		if (
			message.method === "turn/completed" ||
			message.method === "thread/status/changed"
		)
			void this.#emit(
				message.method === "turn/completed"
					? "session.idle"
					: "session.activity",
			);
	}

	async start(): Promise<ManagedCodexStartResult> {
		if (this.#started) {
			return {
				launchable: true,
				deliveryReady: await this.deliveryReady(),
				resumed: true,
				threadId: this.#threadId ?? "",
				endpointId: this.#options.binding.endpointId,
				...(this.#ownerFence === undefined
					? {}
					: { ownerFence: this.#ownerFence }),
				qualification: this.#qualification,
			};
		}
		const binding = this.#options.binding;
		// Endpoint fencing is defined over a canonical generation. Materialize the
		// deterministic lifecycle identity before claiming the native endpoint so
		// a real control-plane never accepts an orphaned App Server owner.
		await this.#emit("session.started", {
			model: this.#qualification.model,
		});
		const claimed = await this.#options.endpoints.claim({
			endpointId: binding.endpointId,
			generationId: binding.generationId,
			routeKind: "delivery",
			ownerInstanceId: binding.ownerInstanceId,
			deliveryMode: "managed_app_server",
			readiness: "uninitialized",
			controlState: "enabled",
			leaseMs: 30_000,
		});
		if (recordString(claimed, "disposition") === "rejected")
			throw new Error("adapter.codex.managed.endpoint_claim_rejected");
		this.#ownerFence =
			recordNumber(claimed, "ownerFence") ??
			recordNumber(claimed, "owner_fence") ??
			binding.ownerFence;
		this.#rpc = new ManagedCodexRpc({
			cwd: this.#options.projectPath,
			...(this.#options.command === undefined
				? {}
				: { command: this.#options.command }),
			...(this.#options.env === undefined ? {} : { env: this.#options.env }),
			onNotification: (message) =>
				this.#handleNotification(message as Readonly<Record<string, unknown>>),
			onExit: () => {
				this.#started = false;
				void this.#options.endpoints.reportHealth?.({
					endpointId: binding.endpointId,
					generationId: binding.generationId,
					ownerInstanceId: binding.ownerInstanceId,
					ownerFence: this.#ownerFence,
					state: "degraded",
				});
			},
			...this.#options.rpc,
		});
		try {
			await this.#rpc.request("initialize", {
				clientInfo: { name: "golem-managed-codex", version: "1" },
				capabilities: { experimentalApi: true },
			});
			this.#rpc.notify("initialized");
			const status = await this.#rpc.request("mcpServerStatus/list", {});
			const mcpReady =
				Array.isArray((status as { readonly data?: unknown })?.data) ||
				Boolean(status);
			const existingThread =
				recordString(claimed, "threadId") ?? recordString(claimed, "thread_id");
			const threadResult = existingThread
				? await this.#rpc.request("thread/resume", {
						threadId: existingThread,
						cwd: this.#options.projectPath,
						sandbox: "read-only",
						approvalPolicy: "untrusted",
					})
				: await this.#rpc.request("thread/start", {
						cwd: this.#options.projectPath,
						sandbox: "read-only",
						approvalPolicy: "untrusted",
					});
			const thread = (
				threadResult as { readonly thread?: { readonly id?: unknown } }
			)?.thread;
			const threadId = typeof thread?.id === "string" ? thread.id : undefined;
			if (!threadId) throw new Error("adapter.codex.managed.thread_missing");
			this.#threadId = threadId;
			if (existingThread) await this.#emit("session.resumed");
			await this.#options.endpoints.reportHealth?.({
				endpointId: binding.endpointId,
				generationId: binding.generationId,
				ownerInstanceId: binding.ownerInstanceId,
				ownerFence: this.#ownerFence,
				state: "healthy",
			});
			await this.#reportCapability(mcpReady ? "uninitialized" : "unsupported");
			this.#started = true;
			return {
				launchable: true,
				deliveryReady: false,
				resumed: Boolean(existingThread),
				threadId,
				endpointId: binding.endpointId,
				...(this.#ownerFence === undefined
					? {}
					: { ownerFence: this.#ownerFence }),
				qualification: this.#qualification,
			};
		} catch (error) {
			await this.stop();
			if (error instanceof ManagedCodexQualificationError) throw error;
			throw new Error("adapter.codex.managed.start_failed");
		}
	}

	async markConsumerReady(): Promise<void> {
		if (!this.#rpc || !this.#threadId)
			throw new Error("adapter.codex.managed.not_started");
		const binding = this.#options.binding;
		await this.#options.endpoints.reportReadiness?.({
			endpointId: binding.endpointId,
			generationId: binding.generationId,
			ownerInstanceId: binding.ownerInstanceId,
			ownerFence: this.#ownerFence,
			deliveryMode: "managed_app_server",
			readiness: "ready",
			controlState: "enabled",
		});
		await this.#options.endpoints.probe?.({
			endpointId: binding.endpointId,
			generationId: binding.generationId,
			ownerInstanceId: binding.ownerInstanceId,
			ownerFence: this.#ownerFence,
			consumerReady: true,
			readiness: "ready",
		});
		await this.#reportCapability("ready");
	}

	async #reportCapability(
		readiness: "ready" | "uninitialized" | "unsupported",
	): Promise<void> {
		const binding = this.#options.binding;
		this.#capabilitySequence += 1;
		const observedAt = new Date(
			Date.parse(nowIso(this.#now)) + this.#capabilitySequence,
		).toISOString();
		const common = {
			endpointId: binding.endpointId,
			generationId: binding.generationId,
			ownerInstanceId: binding.ownerInstanceId,
			ownerFence: this.#ownerFence,
			qualification: "supported",
			evidenceKind: readiness === "ready" ? "observed" : "probe",
			deliveryMode: "managed_app_server",
			readiness,
			observedAt,
			consumptionObserved: readiness === "ready",
		};
		await this.#options.endpoints.reportCapability?.({
			...common,
			capability: "codex.openai.managed",
		});
		// GOL-36's canonical durable delivery port qualifies the universal
		// `delivery` capability. Preserve the adapter-specific fact above while
		// publishing the matching consumable capability instead of treating
		// registration as delivery readiness.
		await this.#options.endpoints.reportCapability?.({
			...common,
			capability: "delivery",
		});
		await this.#options.endpoints.reportCapability?.({
			...common,
			capability: "control",
		});
	}

	async deliveryReady(): Promise<boolean> {
		const result = await this.#options.endpoints.eligibility({
			generationId: this.#options.binding.generationId,
			routeKind: "delivery",
			requiredCapability: "delivery",
			expectedOwnerFence: this.#ownerFence,
		});
		return result.disposition === "eligible";
	}

	async deliver(
		input: ManagedCodexDeliveryInput,
	): Promise<ManagedCodexDeliveryResult> {
		if (!this.#rpc || !this.#threadId)
			return {
				status: "rejected",
				code: "adapter.codex.managed.not_started",
				deliveryId: input.deliveryId,
			};
		const expected = input.expectedOwnerFence ?? this.#ownerFence;
		const delivery = input.delivery ?? this.#options.delivery;
		if (!delivery)
			return {
				status: "rejected",
				code: "adapter.codex.managed.delivery_port_unavailable",
				deliveryId: input.deliveryId,
			};
		const claim = await delivery.claim({
			deliveryId: input.deliveryId,
			generationId: this.#options.binding.generationId,
			expectedOwnerFence: expected,
		});
		const duplicateTurnId = recordString(claim, "turnId");
		if (recordString(claim, "disposition") === "duplicate")
			return {
				status: "duplicate",
				code: "adapter.codex.managed.delivery_duplicate",
				deliveryId: input.deliveryId,
				...(duplicateTurnId ? { turnId: duplicateTurnId } : {}),
			};
		if (
			recordString(claim, "disposition") &&
			recordString(claim, "disposition") !== "accepted"
		)
			return {
				status: "rejected",
				code: "adapter.codex.managed.delivery_claim_rejected",
				deliveryId: input.deliveryId,
			};
		// The durable claim is prepared before local eligibility. That preparation
		// re-resolves a queued endpoint and settles a stale recipient lease; doing
		// it after this check would strand stale claimed envelopes until their
		// lease expired. We still fence again immediately before `turn/start`.
		// Claiming a durable envelope can yield; fence again at the last possible
		// boundary so a replacement supervisor cannot race this process call.
		const finalEligibility = await this.#options.endpoints.eligibility({
			generationId: this.#options.binding.generationId,
			routeKind: "delivery",
			requiredCapability: "delivery",
			expectedOwnerFence: expected,
		});
		if (finalEligibility.disposition !== "eligible") {
			await delivery.fail({
				deliveryId: input.deliveryId,
				reason: "managed_codex_fence_changed",
			});
			return {
				status: "rejected",
				code: "adapter.codex.managed.fence_stale",
				deliveryId: input.deliveryId,
			};
		}
		try {
			// `clientUserMessageId` is the durable idempotency key at the App
			// Server boundary. It makes the small crash window before our marker
			// safe to retry rather than dropping a never-started turn.
			const result = await this.#rpc.request("turn/start", {
				threadId: this.#threadId,
				cwd: this.#options.projectPath,
				clientUserMessageId: input.deliveryId,
				input: [{ type: "text", text: input.text }],
			});
			const turnId =
				recordString(
					(result as Readonly<Record<string, unknown>>) ?? {},
					"turnId",
				) ??
				recordString(
					(result as { readonly turn?: Readonly<Record<string, unknown>> })
						?.turn ?? {},
					"id",
				);
			// Persist only after `turn/start` has succeeded. A crash before here
			// retries this exact client id; a crash after here cannot issue a second
			// transport request while acknowledgement is reconciled durably.
			await delivery.markSent({
				deliveryId: input.deliveryId,
				...(turnId ? { turnId } : {}),
			});
			const delivered: ManagedCodexDeliveryResult = {
				status: "accepted",
				code: "adapter.codex.managed.delivery_accepted",
				deliveryId: input.deliveryId,
				...(turnId ? { turnId } : {}),
			};
			await delivery.ack({
				deliveryId: input.deliveryId,
				turnId,
			});
			await this.#options.endpoints.reportDelivery?.({
				endpointId: this.#options.binding.endpointId,
				generationId: this.#options.binding.generationId,
				ownerInstanceId: this.#options.binding.ownerInstanceId,
				ownerFence: this.#ownerFence,
				status: "delivered",
				readiness: "ready",
			});
			return delivered;
		} catch {
			await delivery.fail({
				deliveryId: input.deliveryId,
				reason: "managed_codex_delivery_failed",
			});
			return {
				status: "retry",
				code: "adapter.codex.managed.delivery_failed",
				deliveryId: input.deliveryId,
			};
		}
	}

	async control(action: "interrupt" | "halt" | "resume"): Promise<{
		readonly status: "accepted" | "rejected";
		readonly code: string;
	}> {
		if (!this.#rpc || !this.#threadId)
			return { status: "rejected", code: "adapter.codex.managed.not_started" };
		const eligible = await this.#options.endpoints.eligibility({
			generationId: this.#options.binding.generationId,
			// Managed App Server control is exercised by the same fenced owner as
			// delivery. It still requires the independently observed `control`
			// capability; using the delivery route avoids inventing an unclaimed
			// second endpoint for this one owned process.
			routeKind: "delivery",
			requiredCapability: "control",
			expectedOwnerFence: this.#ownerFence,
		});
		if (eligible.disposition !== "eligible")
			return {
				status: "rejected",
				code: "adapter.codex.managed.control_ineligible",
			};
		const method =
			action === "interrupt"
				? "turn/interrupt"
				: action === "halt"
					? "thread/archive"
					: "thread/resume";
		try {
			await this.#rpc.request(method, { threadId: this.#threadId });
			return {
				status: "accepted",
				code: `adapter.codex.managed.control_${action}`,
			};
		} catch {
			return {
				status: "rejected",
				code: "adapter.codex.managed.control_failed",
			};
		}
	}

	async stop(options: { readonly release?: boolean } = {}): Promise<void> {
		const binding = this.#options.binding;
		if (
			options.release !== false &&
			this.#options.endpoints.release &&
			this.#ownerFence !== undefined
		)
			await this.#options.endpoints.release({
				endpointId: binding.endpointId,
				generationId: binding.generationId,
				ownerInstanceId: binding.ownerInstanceId,
				ownerFence: this.#ownerFence,
			});
		await this.#rpc?.close();
		this.#rpc = undefined;
		this.#started = false;
	}
}
