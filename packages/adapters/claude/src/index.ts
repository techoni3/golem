import type { AdapterBoundary } from "@golem/adapter-sdk";
import {
	type CapabilityRecord,
	CapabilityRecordSchema,
	contractBoundary,
	type DeliveryMode,
	type DeliveryReadiness,
	type RuntimeSignalV1,
	RuntimeSignalV1Schema,
} from "@golem/contracts";

export const CLAUDE_ADAPTER_VERSION = "1.0.0";
export const CLAUDE_CHANNEL_PROTOCOL = "golem.claude-channel/v1";
export const CLAUDE_CONSUMPTION_MARKER = "golem.claude.consumed/v1";

export interface ClaudeAdapterBoundary extends AdapterBoundary {
	readonly adapter: ClaudeAdapter;
}

export interface ClaudeClock {
	now(): string;
}

export interface ClaudeProjectContext {
	readonly projectId: string;
	readonly locationId?: string;
	readonly canonicalPath: string;
	readonly observedPath?: string;
	readonly relation?: "main" | "worktree" | "registered" | "legacy";
	readonly producerInstanceId?: string;
	readonly generationId?: string;
	readonly sessionId?: string;
	readonly sequence?: number;
}

export interface ClaudeHookInput {
	readonly hook_event_name?: string;
	readonly event?: string;
	readonly session_id: string;
	readonly cwd?: string;
	readonly timestamp?: string;
	readonly model?: string;
	readonly source?: string;
	readonly resumed?: boolean;
	readonly notification_type?: string;
	readonly error?: boolean;
}

export interface ClaudeHookResult {
	readonly signals: readonly RuntimeSignalV1[];
	readonly sessionId: string;
	readonly generationId: string;
}

export interface ClaudeSignalSink {
	ingest(
		signal: RuntimeSignalV1,
	):
		| void
		| { readonly disposition?: string; readonly code?: string }
		| Promise<unknown>;
}

export interface ClaudeHookReceipt extends ClaudeHookResult {
	readonly results: readonly Readonly<Record<string, unknown>>[];
	readonly failed: boolean;
}

export interface ClaudeEndpointPort {
	claim(input: {
		readonly generationId: string;
		readonly routeKind: "delivery";
		readonly ownerInstanceId: string;
		readonly deliveryMode: DeliveryMode;
		readonly readiness: DeliveryReadiness;
		readonly leaseMs: number;
	}):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	heartbeat(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	probe(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	reportReadiness(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	reportDelivery(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	reportCapability(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
	release(
		input: Readonly<Record<string, unknown>>,
	):
		| Promise<Readonly<Record<string, unknown>>>
		| Readonly<Record<string, unknown>>;
}

export interface ClaudeChannelOwnerOptions {
	readonly endpoint: ClaudeEndpointPort;
	readonly generationId: string;
	readonly sessionId: string;
	readonly ownerInstanceId: string;
	readonly ownerSecret: string;
	readonly leaseMs?: number;
	readonly clock?: ClaudeClock;
}

export interface ClaudeChannelHandshake {
	readonly sessionId: string;
	readonly protocol: string;
	readonly ownerSecret: string;
}

export interface ClaudeConsumptionProof {
	readonly sessionId: string;
	readonly marker: string;
	readonly modelVersion: string;
	readonly claudeVersion: string;
	readonly addressed: boolean;
}

export interface ClaudeChannelOwner {
	readonly endpointId: string;
	readonly ownerFence: number;
	readonly start: () => Promise<void>;
	readonly heartbeat: () => Promise<void>;
	readonly handshake: (input: ClaudeChannelHandshake) => Promise<boolean>;
	readonly consume: (proof: ClaudeConsumptionProof) => Promise<boolean>;
	readonly release: () => Promise<void>;
	readonly snapshot: () => Readonly<{
		readonly endpointId: string;
		readonly ownerFence: number;
		readonly handshaken: boolean;
		readonly qualified: boolean;
	}>;
}

export interface ClaudeQualificationPort {
	launch(): Promise<{
		readonly ok: boolean;
		readonly claudeVersion?: string;
		readonly backendVersion?: string;
		readonly modelVersion?: string;
		readonly reasonCode?: string;
	}>;
	consume(input: {
		readonly marker: string;
		readonly addressed: true;
	}): Promise<{
		readonly consumed: boolean;
		readonly claudeVersion?: string;
		readonly modelVersion?: string;
	}>;
}

export interface ClaudeQualificationResult {
	readonly capability: CapabilityRecord;
	readonly launchable: boolean;
	readonly readiness: DeliveryReadiness;
	readonly reasonCode: string;
	readonly remediation: string;
	readonly evidence: Readonly<{
		readonly adapterVersion: string;
		readonly claudeVersion?: string;
		readonly backendVersion?: string;
		readonly modelVersion?: string;
		readonly marker?: string;
	}>;
}

export interface ClaudeRenderContribution {
	readonly target: "cc";
	readonly marketplaceTarget: "cc-marketplace";
	readonly pluginName: "golem";
	readonly sourceRoot: "substrate";
	readonly generated: true;
	readonly hookEvents: readonly string[];
	readonly requiredFiles: readonly string[];
	readonly mcpServer: Readonly<{
		readonly command: "node";
		readonly args: readonly ["${CLAUDE_PLUGIN_ROOT}/mcp/channel/index.js"];
		readonly nodePath: "${CLAUDE_PLUGIN_ROOT}/mcp/channel/node_modules";
	}>;
}

const CLAUDE_PLUGIN_ROOT = "$" + "{CLAUDE_PLUGIN_ROOT}";

export interface ClaudeLaunchContribution {
	readonly executable: "claude";
	readonly argv: readonly string[];
	readonly environmentKeyRefs: readonly string[];
	readonly pluginRef?: "plugin:golem@golem-workspace";
}

function uuid(prefix: string, seed: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < seed.length; index += 1) {
		const code = seed.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code ^ index, 0x85ebca6b) >>> 0;
	}
	const hex = `${first.toString(16).padStart(8, "0")}${second
		.toString(16)
		.padStart(8, "0")}${first.toString(16).padStart(8, "0")}${second
		.toString(16)
		.padStart(8, "0")}`;
	const normalized = hex.split("");
	normalized[12] = "4";
	normalized[16] = (
		(Number.parseInt(normalized[16] ?? "8", 16) & 0x3) |
		0x8
	).toString(16);
	const value = normalized.join("");
	return `${prefix}_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function opaqueId(prefix: string, value: string): string {
	const pattern = new RegExp(
		`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
		"u",
	);
	return pattern.test(value) ? value : uuid(prefix, value);
}

function timestamp(input: string | undefined, clock: ClaudeClock): string {
	const now = clock.now();
	if (!input) return now;
	const parsed = Date.parse(input);
	const current = Date.parse(now);
	return Number.isFinite(parsed) && parsed <= current
		? new Date(parsed).toISOString()
		: now;
}

function cleanText(value: string | undefined, fallback: string): string {
	const text = value?.trim();
	if (
		!text ||
		/(?:token|credential|password|secret|api[_-]?key|authorization|bearer)\s*[:=]/iu.test(
			text,
		)
	)
		return fallback;
	return text.slice(0, 128);
}

function safeVersion(value: string | undefined): string | undefined {
	const text = value?.trim();
	if (
		!text ||
		/(?:token|credential|password|secret|api[_-]?key|authorization|bearer)\s*[:=]/iu.test(
			text,
		)
	)
		return undefined;
	return text.slice(0, 128);
}

function eventName(input: ClaudeHookInput): string {
	return (input.hook_event_name ?? input.event ?? "").trim().toLowerCase();
}

function metadata(input: ClaudeHookInput): Record<string, string> {
	const result: Record<string, string> = {};
	const model = safeVersion(input.model);
	const source = cleanText(input.source, "");
	if (model) result.model = model;
	if (source) result.source = source.slice(0, 64);
	return result;
}

function signal(
	context: ClaudeProjectContext,
	input: ClaudeHookInput,
	clock: ClaudeClock,
	eventKind: RuntimeSignalV1["event_kind"],
	payload: unknown,
	seed: string,
): RuntimeSignalV1 {
	const receivedAt = clock.now();
	const eventId = opaqueId(
		"evt",
		`${context.projectId}:${input.session_id}:${seed}:${receivedAt}`,
	);
	return RuntimeSignalV1Schema.parse({
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId,
		event_kind: eventKind,
		producer: "claude-adapter",
		producer_instance_id: opaqueId(
			"prod",
			context.producerInstanceId ?? "claude-adapter",
		),
		harness: "claude",
		...(context.sequence !== undefined
			? { producer_sequence: context.sequence }
			: {}),
		correlation_id: opaqueId(
			"evt",
			`${context.projectId}:${input.session_id}:correlation`,
		),
		deduplication_key: `claude:${context.projectId}:${input.session_id}:${seed}`,
		clocks: {
			source_observed_at: timestamp(input.timestamp, clock),
			received_at: receivedAt,
		},
		provenance: {
			source: "adapter",
			confidence: "observed",
			evidence_id: eventId,
		},
		clear_fields: [],
		payload,
	});
}

function generationReference(
	context: ClaudeProjectContext,
	input: ClaudeHookInput,
) {
	const sessionId = opaqueId("ses", context.sessionId ?? input.session_id);
	const generationId = opaqueId(
		"gen",
		context.generationId ?? `${sessionId}:${context.sequence ?? 0}`,
	);
	return {
		sessionId,
		generationId,
		generation: {
			project_id: opaqueId("prj", context.projectId),
			session_id: sessionId,
			generation_id: generationId,
		},
	};
}

export function parseClaudeHook(
	input: ClaudeHookInput,
	context: ClaudeProjectContext,
	clock: ClaudeClock = { now: () => new Date().toISOString() },
): ClaudeHookResult {
	const { sessionId, generationId, generation } = generationReference(
		context,
		input,
	);
	const kind = eventName(input);
	const signals: RuntimeSignalV1[] = [];
	if (kind === "sessionstart" || kind === "session_start" || kind === "start") {
		const projectId = generation.project_id;
		const locationId = opaqueId(
			"loc",
			context.locationId ?? context.canonicalPath,
		);
		signals.push(
			signal(
				context,
				input,
				clock,
				"project.observed",
				{
					kind: "project.observed",
					project: { project_id: projectId },
					location: {
						project_id: projectId,
						location_id: locationId,
						relation: context.relation ?? "registered",
						canonical_path: context.canonicalPath.slice(0, 4096),
						...(context.observedPath
							? { observed_path: context.observedPath.slice(0, 4096) }
							: {}),
					},
				},
				"project",
			),
		);
		signals.push(
			signal(
				context,
				input,
				clock,
				"session.started",
				{ kind: "session.started", generation, metadata: metadata(input) },
				"session.started",
			),
		);
	} else if (
		kind === "sessionresume" ||
		kind === "session_resume" ||
		input.resumed
	) {
		signals.push(
			signal(
				context,
				input,
				clock,
				"session.resumed",
				{
					kind: "session.resumed",
					generation,
					...(context.generationId
						? {
								resumed_from_generation_id: opaqueId(
									"gen",
									context.generationId,
								),
							}
						: {}),
				},
				"session.resumed",
			),
		);
	} else if (
		kind === "userpromptsubmit" ||
		kind === "user_prompt_submit" ||
		kind === "prompt"
	) {
		signals.push(
			signal(
				context,
				input,
				clock,
				"session.activity",
				{ kind: "session.activity", generation, activity_kind: "prompt" },
				"prompt",
			),
		);
	} else if (
		kind === "pretooluse" ||
		kind === "posttooluse" ||
		kind === "tool"
	) {
		signals.push(
			signal(
				context,
				input,
				clock,
				"session.activity",
				{ kind: "session.activity", generation, activity_kind: "tool" },
				"tool",
			),
		);
	} else if (
		kind === "notification" ||
		kind === "needs_input" ||
		kind === "waiting"
	) {
		const waiting = /(?:permission|input|approval|waiting)/iu.test(
			input.notification_type ?? "",
		);
		signals.push(
			signal(
				context,
				input,
				clock,
				waiting ? "session.waiting" : "session.idle",
				waiting
					? {
							kind: "session.waiting",
							generation,
							reason: cleanText(input.notification_type, "claude.notification"),
						}
					: { kind: "session.idle", generation },
				waiting ? "waiting" : "idle",
			),
		);
	} else if (
		kind === "stop" ||
		kind === "sessionstop" ||
		kind === "session_end" ||
		kind === "sessionend" ||
		kind === "end"
	) {
		const disposition = input.error ? "errored" : "ended";
		signals.push(
			signal(
				context,
				input,
				clock,
				"session.ended",
				{ kind: "session.ended", generation, disposition },
				"ended",
			),
		);
	} else {
		throw new Error("claude.hook.unsupported_event");
	}
	return Object.freeze({
		signals: Object.freeze(signals),
		sessionId,
		generationId,
	});
}

export async function ingestClaudeHook(
	input: ClaudeHookInput,
	context: ClaudeProjectContext,
	sink: ClaudeSignalSink,
	clock?: ClaudeClock,
): Promise<ClaudeHookReceipt> {
	const result = parseClaudeHook(input, context, clock);
	const results: Readonly<Record<string, unknown>>[] = [];
	let failed = false;
	for (const item of result.signals) {
		try {
			const outcome = await sink.ingest(item);
			results.push({
				event_id: item.event_id,
				disposition:
					outcome && typeof outcome === "object"
						? ((outcome as { readonly disposition?: string }).disposition ??
							"accepted")
						: "accepted",
			});
		} catch {
			failed = true;
			results.push({ event_id: item.event_id, disposition: "spooled" });
		}
	}
	return Object.freeze({
		...result,
		results: Object.freeze(results),
		failed,
	});
}

function secretsEqual(expected: string, actual: string): boolean {
	if (expected.length !== actual.length) return false;
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1)
		difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
	return difference === 0;
}

function accepted(
	result: Readonly<Record<string, unknown>>,
	code: string,
): void {
	if (result.disposition !== "accepted" && result.disposition !== "eligible")
		throw new Error(code);
}

export function createClaudeChannelOwner(
	options: ClaudeChannelOwnerOptions,
): ClaudeChannelOwner {
	const leaseMs = options.leaseMs ?? 30_000;
	const clock = options.clock ?? { now: () => new Date().toISOString() };
	let endpointId = "";
	let ownerFence = 0;
	let handshaken = false;
	let qualified = false;
	let started = false;
	const authority = () => ({
		generationId: options.generationId,
		ownerInstanceId: options.ownerInstanceId,
		ownerFence,
		endpointId,
	});
	return {
		get endpointId() {
			return endpointId;
		},
		get ownerFence() {
			return ownerFence;
		},
		async start() {
			if (started) return;
			const result = await options.endpoint.claim({
				generationId: options.generationId,
				routeKind: "delivery",
				ownerInstanceId: options.ownerInstanceId,
				deliveryMode: "native_channel",
				readiness: "uninitialized",
				leaseMs,
			});
			accepted(result, "claude.channel.claim_rejected");
			endpointId = String(result.endpointId ?? "");
			ownerFence = Number(result.ownerFence ?? 0);
			if (!endpointId || !Number.isSafeInteger(ownerFence) || ownerFence < 1)
				throw new Error("claude.channel.claim_invalid");
			started = true;
		},
		async heartbeat() {
			if (!started) throw new Error("claude.channel.not_started");
			accepted(
				await options.endpoint.heartbeat({
					...authority(),
					heartbeatAt: clock.now(),
					leaseMs,
				}),
				"claude.channel.heartbeat_rejected",
			);
		},
		async handshake(input) {
			if (
				!started ||
				input.sessionId !== options.sessionId ||
				input.protocol !== CLAUDE_CHANNEL_PROTOCOL ||
				!secretsEqual(options.ownerSecret, input.ownerSecret)
			)
				return false;
			accepted(
				await options.endpoint.probe({
					...authority(),
					consumerReady: true,
					readiness: "held_waiting",
				}),
				"claude.channel.probe_rejected",
			);
			accepted(
				await options.endpoint.reportReadiness({
					...authority(),
					deliveryMode: "native_channel",
					readiness: "held_waiting",
				}),
				"claude.channel.readiness_rejected",
			);
			handshaken = true;
			return true;
		},
		async consume(proof) {
			const claudeVersion = safeVersion(proof.claudeVersion);
			const modelVersion = safeVersion(proof.modelVersion);
			if (
				!handshaken ||
				proof.sessionId !== options.sessionId ||
				proof.marker !== CLAUDE_CONSUMPTION_MARKER ||
				proof.addressed !== true ||
				!modelVersion ||
				!claudeVersion
			)
				return false;
			accepted(
				await options.endpoint.reportDelivery({
					...authority(),
					status: "delivered",
					readiness: "ready",
				}),
				"claude.channel.delivery_rejected",
			);
			accepted(
				await options.endpoint.reportReadiness({
					...authority(),
					deliveryMode: "native_channel",
					readiness: "ready",
				}),
				"claude.channel.readiness_rejected",
			);
			accepted(
				await options.endpoint.reportCapability({
					...authority(),
					capability: {
						capability: "claude.channel",
						adapterId: "claude",
						adapterVersion: CLAUDE_ADAPTER_VERSION,
						qualification: "supported",
						deliveryMode: "native_channel",
						readiness: "ready",
						evidenceKind: "observed",
						observedAt: clock.now(),
					},
					evidence: {
						marker: proof.marker,
						addressed: true,
						claude_version: claudeVersion,
						model_version: modelVersion,
					},
				}),
				"claude.channel.capability_rejected",
			);
			qualified = true;
			return true;
		},
		async release() {
			if (!started) return;
			accepted(
				await options.endpoint.release(authority()),
				"claude.channel.release_rejected",
			);
			started = false;
			handshaken = false;
			qualified = false;
		},
		snapshot() {
			return Object.freeze({ endpointId, ownerFence, handshaken, qualified });
		},
	};
}

export async function qualifyClaude(
	port: ClaudeQualificationPort,
	options: { readonly modelVersion?: string } = {},
): Promise<ClaudeQualificationResult> {
	const launch = await port.launch();
	const base = {
		adapterVersion: CLAUDE_ADAPTER_VERSION,
		...(safeVersion(launch.claudeVersion)
			? { claudeVersion: safeVersion(launch.claudeVersion) }
			: {}),
		...(safeVersion(launch.backendVersion)
			? { backendVersion: safeVersion(launch.backendVersion) }
			: {}),
		...(safeVersion(launch.modelVersion ?? options.modelVersion)
			? {
					modelVersion: safeVersion(
						launch.modelVersion ?? options.modelVersion,
					),
				}
			: {}),
	};
	if (!launch.ok)
		return result(
			"unsupported",
			"unsupported",
			false,
			launch.reasonCode ?? "claude.launch.unavailable",
			"Install a supported Claude executable and verify its launch preflight.",
			base,
		);
	const consumed = await port.consume({
		marker: CLAUDE_CONSUMPTION_MARKER,
		addressed: true,
	});
	if (!consumed.consumed)
		return result(
			"unknown",
			"pull_only",
			true,
			"claude.delivery.unqualified",
			"Run the real addressed Claude channel consumption journey before advertising push delivery.",
			{
				...base,
				...(safeVersion(consumed.claudeVersion)
					? { claudeVersion: safeVersion(consumed.claudeVersion) }
					: {}),
				...(safeVersion(consumed.modelVersion)
					? { modelVersion: safeVersion(consumed.modelVersion) }
					: {}),
			},
		);
	return result(
		"supported",
		"ready",
		true,
		"claude.delivery.qualified",
		"Keep the authenticated channel and model-consumption evidence current.",
		{
			...base,
			marker: CLAUDE_CONSUMPTION_MARKER,
			...(safeVersion(consumed.claudeVersion)
				? { claudeVersion: safeVersion(consumed.claudeVersion) }
				: {}),
			...(safeVersion(consumed.modelVersion)
				? { modelVersion: safeVersion(consumed.modelVersion) }
				: {}),
		},
	);
}

function result(
	qualification: CapabilityRecord["qualification"],
	readiness: DeliveryReadiness,
	launchable: boolean,
	reasonCode: string,
	remediation: string,
	evidence: Readonly<Record<string, string | undefined>>,
): ClaudeQualificationResult {
	const capability = CapabilityRecordSchema.parse({
		schema_version: "golem.capability-record/v1",
		capability_id: "claude.anthropic.direct",
		harness: "claude",
		adapter_version: CLAUDE_ADAPTER_VERSION,
		integration_layers: ["hooks", "mcp", "channel"],
		qualification,
		delivery_mode: "native_channel",
		readiness,
		reason_code: reasonCode,
		evidence_version: "golem.claude-qualification/v1",
	});
	return Object.freeze({
		capability,
		launchable,
		readiness,
		reasonCode,
		remediation,
		evidence: Object.freeze({
			adapterVersion: CLAUDE_ADAPTER_VERSION,
			...evidence,
		}),
	});
}

export function buildClaudeRenderContribution(): ClaudeRenderContribution {
	return Object.freeze({
		target: "cc",
		marketplaceTarget: "cc-marketplace",
		pluginName: "golem",
		sourceRoot: "substrate",
		generated: true,
		hookEvents: Object.freeze([
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Notification",
			"Stop",
		]),
		requiredFiles: Object.freeze([
			"hooks/hooks.json",
			"hooks/session-register.sh",
			"hooks/journal-route.sh",
			"mcp/channel/index.js",
			".mcp.json",
			".claude-plugin/plugin.json",
		]),
		mcpServer: Object.freeze({
			command: "node",
			args: [`${CLAUDE_PLUGIN_ROOT}/mcp/channel/index.js`] as const,
			nodePath: `${CLAUDE_PLUGIN_ROOT}/mcp/channel/node_modules`,
		}),
	});
}

export function buildClaudeLaunchContribution(
	input: {
		readonly mode?: "direct" | "managed";
		readonly backend?: "anthropic" | "ollama_local" | "ollama_cloud";
		readonly model?: string;
		readonly baseUrlEnvKey?: string;
	} = {},
): ClaudeLaunchContribution {
	const mode = input.mode ?? "direct";
	const backend = input.backend ?? "anthropic";
	const model = input.model?.trim();
	if (model && /[\0\r\n;&|`$<>()]/u.test(model))
		throw new Error("claude.launch.model_unsafe");
	const baseUrlEnvKey = input.baseUrlEnvKey;
	if (baseUrlEnvKey && !/^[A-Z][A-Z0-9_]*$/u.test(baseUrlEnvKey))
		throw new Error("claude.launch.environment_key_invalid");
	const environmentKeyRefs =
		backend === "anthropic"
			? ["ANTHROPIC_API_KEY"]
			: baseUrlEnvKey
				? [baseUrlEnvKey]
				: [];
	const argv =
		mode === "managed"
			? [
					"--dangerously-load-development-channels",
					"plugin:golem@golem-workspace",
				]
			: [];
	return Object.freeze({
		executable: "claude",
		argv: Object.freeze(argv),
		environmentKeyRefs: Object.freeze(environmentKeyRefs),
		...(mode === "managed"
			? { pluginRef: "plugin:golem@golem-workspace" as const }
			: {}),
	});
}

export interface ClaudeAdapter {
	readonly harness: "claude";
	readonly version: string;
	readonly contract: typeof contractBoundary;
	readonly parseHook: (
		input: ClaudeHookInput,
		context: ClaudeProjectContext,
	) => ClaudeHookResult;
	readonly ingestHook: (
		input: ClaudeHookInput,
		context: ClaudeProjectContext,
		sink: ClaudeSignalSink,
	) => Promise<ClaudeHookReceipt>;
	readonly buildRenderContribution: typeof buildClaudeRenderContribution;
	readonly buildLaunchContribution: typeof buildClaudeLaunchContribution;
	readonly qualify: typeof qualifyClaude;
}

export function createClaudeAdapter(
	options: { readonly clock?: ClaudeClock } = {},
): ClaudeAdapter {
	const clock = options.clock ?? { now: () => new Date().toISOString() };
	return Object.freeze({
		harness: "claude" as const,
		version: CLAUDE_ADAPTER_VERSION,
		contract: contractBoundary,
		parseHook: (input: ClaudeHookInput, context: ClaudeProjectContext) =>
			parseClaudeHook(input, context, clock),
		ingestHook: (
			input: ClaudeHookInput,
			context: ClaudeProjectContext,
			sink: ClaudeSignalSink,
		) => ingestClaudeHook(input, context, sink, clock),
		buildRenderContribution: buildClaudeRenderContribution,
		buildLaunchContribution: buildClaudeLaunchContribution,
		qualify: qualifyClaude,
	});
}
