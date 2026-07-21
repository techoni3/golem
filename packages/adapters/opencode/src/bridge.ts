import type {
	OpenCodeBridgePort,
	OpenCodeDeliveryRequest,
	OpenCodeDeliveryResult,
	OpenCodeFence,
} from "./types.js";

function stableCode(code: string): OpenCodeDeliveryResult {
	return { status: "rejected", code };
}

/**
 * The adapter owns only the last-mile SDK call. Generation, fence and
 * eligibility remain inputs from the canonical endpoint service and are
 * checked immediately before promptAsync.
 */
export class FencedOpenCodeBridge {
	readonly #port: OpenCodeBridgePort;
	readonly #accepted = new Map<string, OpenCodeDeliveryResult>();
	readonly #sessionId: string;
	#fence: OpenCodeFence | undefined;

	constructor(options: {
		readonly sessionId: string;
		readonly port: OpenCodeBridgePort;
		readonly fence?: OpenCodeFence;
	}) {
		this.#sessionId = options.sessionId;
		this.#port = options.port;
		this.#fence = options.fence;
	}

	setFence(fence: OpenCodeFence): void {
		this.#fence = fence;
	}

	async deliver(
		request: OpenCodeDeliveryRequest,
	): Promise<OpenCodeDeliveryResult> {
		const prior = this.#accepted.get(request.deliveryId);
		if (prior) return prior;
		const current = this.#fence;
		if (!current?.eligible)
			return stableCode("adapter.opencode.delivery.ineligible");
		if (
			request.fence.generationId !== current.generationId ||
			request.fence.ownerFence !== current.ownerFence
		)
			return stableCode("adapter.opencode.fence_stale");
		if (request.sessionId !== this.#sessionId)
			return stableCode("adapter.opencode.session_mismatch");
		try {
			const response = await this.#port.promptAsync({
				sessionId: this.#sessionId,
				text: request.text,
				throwOnError: true,
			});
			const result: OpenCodeDeliveryResult = response.accepted
				? {
						status: "accepted",
						code: "adapter.opencode.prompt.accepted",
						...(response.receipt ? { receipt: response.receipt } : {}),
					}
				: { status: "retry", code: "adapter.opencode.prompt.rejected" };
			if (result.status === "accepted")
				this.#accepted.set(request.deliveryId, result);
			return result;
		} catch {
			return { status: "retry", code: "adapter.opencode.prompt.failed" };
		}
	}

	async control(
		action: "interrupt" | "halt" | "resume",
		fence: OpenCodeFence,
	): Promise<OpenCodeDeliveryResult> {
		const current = this.#fence;
		if (!current?.eligible)
			return stableCode("adapter.opencode.control.ineligible");
		if (
			current.generationId !== fence.generationId ||
			current.ownerFence !== fence.ownerFence
		)
			return stableCode("adapter.opencode.fence_stale");
		if (!this.#port.control)
			return stableCode("adapter.opencode.control.unsupported");
		try {
			const response = await this.#port.control({
				sessionId: this.#sessionId,
				action,
			});
			return response.accepted
				? { status: "accepted", code: "adapter.opencode.control.accepted" }
				: { status: "retry", code: "adapter.opencode.control.rejected" };
		} catch {
			return { status: "retry", code: "adapter.opencode.control.failed" };
		}
	}
}
