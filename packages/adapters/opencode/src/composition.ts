import type { RuntimeSignalV1 } from "@golem/contracts";
import { FencedOpenCodeBridge } from "./bridge.js";
import { OpenCodeEventAdapter } from "./events.js";
import type {
	OpenCodeAdapterOptions,
	OpenCodeBridgePort,
	OpenCodeDeliveryRequest,
	OpenCodeDeliveryResult,
	OpenCodeEvent,
	OpenCodeFence,
} from "./types.js";

/** A producer can submit events, but never receives persistence authority. */
export interface OpenCodeRuntimeIngress {
	ingest(signal: RuntimeSignalV1): Promise<void>;
}

export interface OpenCodeControlPlaneIngressOptions {
	readonly origin: string;
	readonly token: string;
	readonly fetch?: typeof globalThis.fetch;
	/** Keep a host-side event handler from awaiting an unavailable control plane. */
	readonly timeoutMs?: number;
}

export class OpenCodeRuntimeIngressError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "OpenCodeRuntimeIngressError";
		this.code = code;
	}
}

/**
 * The only HTTP edge used by the OpenCode compatibility shim. The bearer is
 * never included in diagnostics and a non-202 response is deliberately
 * collapsed to a stable code.
 */
export function createOpenCodeControlPlaneIngress(
	options: OpenCodeControlPlaneIngressOptions,
): OpenCodeRuntimeIngress {
	const origin = options.origin.replace(/\/+$/u, "");
	const request = options.fetch ?? globalThis.fetch;
	// Native event handlers must remain bounded, while local startup/recovery can
	// legitimately take longer than one scheduler slice.
	const timeoutMs = options.timeoutMs ?? 2_000;
	return Object.freeze({
		async ingest(signal: RuntimeSignalV1) {
			let response: Response;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			try {
				response = await request(`${origin}/api/v1/runtime/events`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${options.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(signal),
					signal: controller.signal,
				});
			} catch {
				throw new OpenCodeRuntimeIngressError(
					"adapter.opencode.runtime.ingest_unavailable",
				);
			} finally {
				clearTimeout(timeout);
			}
			if (response.status !== 202)
				throw new OpenCodeRuntimeIngressError(
					"adapter.opencode.runtime.ingest_rejected",
				);
		},
	});
}

/**
 * Joins native OpenCode events to the durable runtime boundary, while keeping
 * endpoint eligibility and SQLite ownership outside the adapter package.
 */
export class OpenCodeCompatibilityRuntime {
	readonly #events: OpenCodeEventAdapter;
	readonly #ingress: OpenCodeRuntimeIngress;
	readonly #bridges = new Map<
		string,
		{ readonly generationId: string; readonly bridge: FencedOpenCodeBridge }
	>();

	constructor(
		options: OpenCodeAdapterOptions & {
			readonly ingress: OpenCodeRuntimeIngress;
		},
	) {
		this.#events = new OpenCodeEventAdapter(options);
		this.#ingress = options.ingress;
	}

	async consume(event: OpenCodeEvent): Promise<RuntimeSignalV1 | undefined> {
		const signal = this.#events.consume(event);
		if (signal) await this.#ingress.ingest(signal);
		return signal;
	}

	stateFor(rawSessionId: string) {
		return this.#events.stateFor(rawSessionId);
	}

	async deliver(input: {
		readonly rawSessionId: string;
		readonly request: Omit<OpenCodeDeliveryRequest, "sessionId">;
		readonly port: OpenCodeBridgePort;
	}): Promise<OpenCodeDeliveryResult> {
		const state = this.#events.stateFor(input.rawSessionId);
		if (!state)
			return {
				status: "rejected",
				code: "adapter.opencode.delivery.session_unknown",
			};
		if (input.request.fence.generationId !== state.generationId)
			return { status: "rejected", code: "adapter.opencode.fence_stale" };
		let current = this.#bridges.get(input.rawSessionId);
		if (!current || current.generationId !== state.generationId) {
			const nativePort: OpenCodeBridgePort = {
				promptAsync: (request) =>
					input.port.promptAsync({
						...request,
						sessionId: input.rawSessionId,
					}),
				...(input.port.control
					? {
							control: (request) =>
								input.port.control?.({
									...request,
									sessionId: input.rawSessionId,
								}) ?? Promise.resolve({ accepted: false }),
						}
					: {}),
			};
			current = {
				generationId: state.generationId,
				bridge: new FencedOpenCodeBridge({
					sessionId: state.sessionId,
					port: nativePort,
					fence: input.request.fence,
				}),
			};
			this.#bridges.set(input.rawSessionId, current);
		} else current.bridge.setFence(input.request.fence);
		return current.bridge.deliver({
			...input.request,
			sessionId: state.sessionId,
		});
	}
}

/** Adapt the actual OpenCode SDK's promptAsync acceptance surface. */
export function openCodeSdkPromptPort(client: unknown): OpenCodeBridgePort {
	return {
		async promptAsync(input) {
			const session = (
				client as {
					session?: {
						promptAsync?: (value: unknown) => Promise<{
							error?: unknown;
							response?: { readonly ok?: boolean };
						}>;
					};
				}
			).session;
			if (typeof session?.promptAsync !== "function")
				throw new OpenCodeRuntimeIngressError(
					"adapter.opencode.prompt.unavailable",
				);
			const accepted = await session.promptAsync({
				path: { id: input.sessionId },
				body: { parts: [{ type: "text", text: input.text }] },
				throwOnError: input.throwOnError,
			});
			return { accepted: !accepted?.error && accepted?.response?.ok !== false };
		},
	};
}

export function openCodeFence(value: unknown): OpenCodeFence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	const generationId =
		typeof record.generation_id === "string"
			? record.generation_id
			: typeof record.generationId === "string"
				? record.generationId
				: undefined;
	const ownerFence =
		typeof record.owner_fence === "string"
			? record.owner_fence
			: typeof record.ownerFence === "string"
				? record.ownerFence
				: undefined;
	if (!generationId || !ownerFence || record.eligible !== true)
		return undefined;
	return { generationId, ownerFence, eligible: true };
}
