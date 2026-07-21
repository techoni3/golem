import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ManagedCodexSupervisor } from "@golem/adapter-codex";
import type { RuntimeSignalV1 } from "@golem/contracts";
import {
	createEndpointService,
	createProjectService,
	createSessionService,
} from "@golem/runtime";

import {
	composeManagedCodexSupervisor,
	createManagedCodexDeliveryPort,
} from "./managed-codex.js";
import { openControlPlanePersistence } from "./persistence.js";
import {
	composeControlPlaneEndpointEligibility,
	composeControlPlaneTrackerServices,
} from "./tracker.js";

export interface ManagedCodexControlBinding {
	readonly projectId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly endpointId: string;
	readonly ownerInstanceId: string;
	readonly producerInstanceId: string;
}

export interface ManagedCodexControlOptions {
	readonly golemHome: string;
	readonly cwd: string;
	/** A caller-selected canonical session identity for the managed host. */
	readonly sessionId?: string;
	readonly backend?: string;
	readonly model?: string;
	readonly command?: string;
	readonly rpcArgs?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly binding?: ManagedCodexControlBinding;
	/** The J3 crash seam throws only after a real App Server response. */
	readonly beforeAcknowledge?: (deliveryId: string) => void | Promise<void>;
}

export interface ManagedCodexControl {
	readonly binding: ManagedCodexControlBinding;
	readonly supervisor: ManagedCodexSupervisor;
	/**
	 * Record that the owned foreground consumer is installed. Delivery cannot
	 * start until this succeeds, so endpoint readiness never gets ahead of the
	 * process that claims durable envelopes.
	 */
	startDeliveryConsumer(): Promise<void>;
	enqueue(input: { readonly id: string; readonly text: string }): void;
	drain(): Promise<
		readonly { readonly deliveryId: string; readonly status: string }[]
	>;
	stop(): Promise<void>;
}

const clock = Object.freeze({
	now: () => new Date().toISOString(),
	after: (milliseconds: number) =>
		new Date(Date.now() + milliseconds).toISOString(),
});

function id(prefix: string): string {
	return `${prefix}_${randomUUID()}`;
}

function stringField(
	input: Readonly<Record<string, unknown>>,
	field: string,
): string {
	const value = input[field];
	if (typeof value !== "string" || !value)
		throw new Error("adapter.codex.managed.port_invalid");
	return value;
}

/** Control-plane-owned composition for the foreground `golem codex` host. */
export async function startManagedCodexControl(
	options: ManagedCodexControlOptions,
): Promise<ManagedCodexControl> {
	const requestedSessionId = options.sessionId?.trim();
	if (options.sessionId !== undefined && !requestedSessionId)
		throw new Error("adapter.codex.managed.session_required");
	const owner = openControlPlanePersistence({
		runtimePath: path.join(options.golemHome, "runtime.db"),
		trackerPath: path.join(options.golemHome, "tracker.db"),
	});
	let supervisor: ManagedCodexSupervisor | undefined;
	let consumerStarted = false;
	try {
		const project = createProjectService({
			storage: owner.runtimeProjectStorage(),
		}).register({ cwd: options.cwd });
		const binding =
			options.binding ??
			Object.freeze({
				projectId: project.projectId,
				sessionId: requestedSessionId ?? id("ses"),
				generationId: id("gen"),
				endpointId: id("ep"),
				ownerInstanceId: id("owner"),
				producerInstanceId: id("prod"),
			});
		const sessions = createSessionService({
			projects: owner.runtimeProjectStorage(),
			sessions: owner.runtimeSessionStorage(),
		});
		const endpoints = createEndpointService({
			storage: owner.runtimeEndpointStorage(),
		});
		const deliveries = composeControlPlaneTrackerServices({
			writer: owner,
			clock,
			eligibility: composeControlPlaneEndpointEligibility({
				endpoints: owner.runtimeEndpointStorage(),
				clock,
			}),
		});
		let activePort:
			| ReturnType<typeof createManagedCodexDeliveryPort>
			| undefined;
		supervisor = composeManagedCodexSupervisor({
			endpoints,
			ingress: {
				ingest(signal: RuntimeSignalV1) {
					const result = sessions.apply(signal);
					if (result.disposition === "rejected") throw new Error(result.code);
					return result;
				},
			},
			supervisor: {
				binding,
				projectPath: options.cwd,
				...(options.backend ? { backend: options.backend } : {}),
				...(options.model ? { model: options.model } : {}),
				...(options.command ? { command: options.command } : {}),
				...(options.rpcArgs ? { rpc: { args: options.rpcArgs } } : {}),
				...(options.env ? { env: options.env } : {}),
				delivery: {
					claim: async (input: Readonly<Record<string, unknown>>) => {
						if (!activePort) return { disposition: "rejected" };
						return activePort.claim(input);
					},
					markSent: async (input: Readonly<Record<string, unknown>>) => {
						if (!activePort)
							throw new Error(
								"control_plane.managed_codex.delivery_port_missing",
							);
						return activePort.markSent(input);
					},
					ack: async (input: Readonly<Record<string, unknown>>) => {
						await options.beforeAcknowledge?.(stringField(input, "deliveryId"));
						if (!activePort)
							throw new Error(
								"control_plane.managed_codex.delivery_port_missing",
							);
						return activePort.ack(input);
					},
					fail: async (input: Readonly<Record<string, unknown>>) => {
						if (!activePort)
							throw new Error(
								"control_plane.managed_codex.delivery_port_missing",
							);
						return activePort.fail(input);
					},
				},
			},
		});
		const activeSupervisor = supervisor;
		await activeSupervisor.start();
		const workerId = `managed-codex-${binding.ownerInstanceId}`;
		return Object.freeze({
			binding,
			supervisor: activeSupervisor,
			async startDeliveryConsumer() {
				if (consumerStarted) return;
				await activeSupervisor.markConsumerReady();
				consumerStarted = true;
			},
			enqueue(input: { readonly id: string; readonly text: string }) {
				deliveries.delivery.enqueue({
					id: input.id,
					idempotencyKey: input.id,
					senderId: binding.sessionId,
					recipientId: binding.endpointId,
					kind: "prompt",
					payload: { text: input.text },
				});
			},
			async drain() {
				if (!consumerStarted)
					throw new Error("control_plane.managed_codex.consumer_not_started");
				const outcomes: { deliveryId: string; status: string }[] = [];
				for (const claim of deliveries.delivery.claim(workerId, 32)) {
					const text = claim.envelope.payload.text;
					if (typeof text !== "string") {
						if (claim.prepare().kind === "deliver")
							claim.fail("managed_codex_text_missing");
						continue;
					}
					activePort = createManagedCodexDeliveryPort({ claim });
					try {
						const result = await activeSupervisor.deliver({
							deliveryId: claim.envelope.id,
							text,
							expectedOwnerFence: claim.envelope.endpoint.ownerFence,
						});
						outcomes.push({
							deliveryId: claim.envelope.id,
							status: result.status,
						});
					} finally {
						activePort = undefined;
					}
				}
				return Object.freeze(outcomes);
			},
			async stop() {
				try {
					await supervisor?.stop();
				} finally {
					await owner.close();
				}
			},
		});
	} catch (error) {
		await supervisor?.stop().catch(() => {});
		await owner.close();
		throw error;
	}
}
