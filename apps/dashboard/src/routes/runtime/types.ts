export type RuntimeStream = "live" | "history" | "diagnostics";

export type RuntimeItem = Readonly<Record<string, unknown>>;

export interface RuntimePage {
	readonly schema_version: "golem.runtime-projection/v1";
	readonly stream: `runtime.${RuntimeStream}`;
	readonly resource_revision: number;
	readonly cursor: number;
	readonly next_cursor?: number;
	readonly generated_at: string;
	readonly items: readonly RuntimeItem[];
	readonly explain: Readonly<Record<string, unknown>>;
	readonly observation: Readonly<Record<string, unknown>>;
	readonly drift: Readonly<Record<string, unknown>>;
}

export type RuntimeEndpoint = Readonly<{
	endpoint_id: string;
	route_kind: string;
	state: string;
	owner_fence: number;
	delivery_mode: string;
	readiness: string;
	control_state: string;
	consumer_ready: boolean;
	consumption_observed: boolean;
	delivery_observed: boolean;
	delivery_failed: boolean;
	capabilities: readonly Readonly<Record<string, unknown>>[];
}>;

export function record(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: {};
}

export function text(value: unknown, fallback = "Unknown"): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

export function bool(value: unknown): boolean {
	return value === true;
}

export function number(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function endpoints(item: RuntimeItem): readonly RuntimeEndpoint[] {
	const source = Array.isArray(item.endpoints) ? item.endpoints : [];
	return source
		.map((entry) => record(entry))
		.filter(
			(entry): entry is RuntimeEndpoint =>
				typeof entry.endpoint_id === "string" &&
				typeof entry.route_kind === "string" &&
				typeof entry.state === "string" &&
				typeof entry.owner_fence === "number" &&
				typeof entry.delivery_mode === "string" &&
				typeof entry.readiness === "string" &&
				typeof entry.control_state === "string" &&
				typeof entry.consumer_ready === "boolean" &&
				typeof entry.consumption_observed === "boolean" &&
				typeof entry.delivery_observed === "boolean" &&
				typeof entry.delivery_failed === "boolean" &&
				Array.isArray(entry.capabilities),
		);
}

export function metadata(item: RuntimeItem): Readonly<Record<string, unknown>> {
	return record(item.metadata);
}

export function model(item: RuntimeItem): string {
	const facts = metadata(item);
	return text(facts.model ?? facts.model_name, "Model unknown");
}

export function sessionName(item: RuntimeItem): string {
	const facts = metadata(item);
	return text(facts.name ?? facts.session_name, text(item.session_id));
}

export function projectName(item: RuntimeItem): string {
	const facts = metadata(item);
	return text(facts.project_name ?? facts.projectName, text(item.project_id));
}

export function role(item: RuntimeItem): string {
	return text(metadata(item).role, "Unassigned");
}

export function lifecycle(item: RuntimeItem): string {
	return text(item.state, "unknown");
}

export function isTerminal(item: RuntimeItem): boolean {
	return ["ended", "errored", "superseded"].includes(lifecycle(item));
}

export function activityAt(item: RuntimeItem): string | undefined {
	return typeof item.actor_activity_at === "string"
		? item.actor_activity_at
		: undefined;
}

export function observedAt(item: RuntimeItem): string | undefined {
	const observation = record(item.observation);
	return typeof observation.observed_at === "string"
		? observation.observed_at
		: undefined;
}

export function asRuntimePage(value: unknown): RuntimePage {
	const page = record(value);
	const stream = text(page.stream, "runtime.live");
	if (
		page.schema_version !== "golem.runtime-projection/v1" ||
		(stream !== "runtime.live" &&
			stream !== "runtime.history" &&
			stream !== "runtime.diagnostics") ||
		!Array.isArray(page.items)
	)
		throw new Error("control-plane returned an invalid runtime projection");
	return {
		schema_version: "golem.runtime-projection/v1",
		stream,
		resource_revision: number(page.resource_revision),
		cursor: number(page.cursor),
		...(typeof page.next_cursor === "number"
			? { next_cursor: page.next_cursor }
			: {}),
		generated_at: text(page.generated_at),
		items: page.items.map((item) => record(item)),
		explain: record(page.explain),
		observation: record(page.observation),
		drift: record(page.drift),
	};
}
