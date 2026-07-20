import type { RuntimeSignalV1 } from "@golem/contracts";
import type {
	RuntimeProjectStorage,
	RuntimeSessionAliasInput,
	RuntimeSessionApplyResult,
	RuntimeSessionCommandContext,
	RuntimeSessionStorage,
	RuntimeSessionView,
} from "@golem/persistence";

export interface SessionServiceOptions {
	readonly projects: RuntimeProjectStorage;
	readonly sessions: RuntimeSessionStorage;
}

/** The sole runtime-facing façade for logical session materialization. */
export class SessionService {
	readonly #options: SessionServiceOptions;

	constructor(options: SessionServiceOptions) {
		this.#options = options;
	}

	apply(
		signal: RuntimeSignalV1,
		alias?: RuntimeSessionAliasInput,
	): RuntimeSessionApplyResult {
		const payload = signal.payload;
		if (!("generation" in payload))
			return {
				disposition: "rejected",
				code: "runtime.session.invalid_payload",
			};
		if (!this.#options.projects.get(payload.generation.project_id))
			return {
				disposition: "rejected",
				code: "runtime.session.project_unresolved",
			};
		return this.#options.sessions.apply({
			signal,
			...(alias ? { alias } : {}),
		});
	}

	observe(
		input: Parameters<RuntimeSessionStorage["observe"]>[0],
	): RuntimeSessionApplyResult {
		return this.#options.sessions.observe(input);
	}

	get(projectId: string, sessionId: string): RuntimeSessionView | undefined {
		return this.#options.sessions.get(projectId, sessionId);
	}

	list(projectId: string): readonly RuntimeSessionView[] {
		return this.#options.sessions.list(projectId);
	}

	attachAlias(input: RuntimeSessionAliasInput): RuntimeSessionApplyResult {
		return this.#options.sessions.attachAlias(input);
	}

	rename(
		input: RuntimeSessionCommandContext & { readonly name: string },
	): RuntimeSessionApplyResult {
		return this.#options.sessions.rename(input);
	}

	patchMetadata(
		input: RuntimeSessionCommandContext & {
			readonly metadata: Readonly<Record<string, unknown>>;
			readonly clearFields?: readonly string[];
		},
	): RuntimeSessionApplyResult {
		return this.#options.sessions.patchMetadata(input);
	}

	end(
		input: RuntimeSessionCommandContext & {
			readonly disposition: "ended" | "errored" | "superseded";
		},
	): RuntimeSessionApplyResult {
		return this.#options.sessions.end(input);
	}
}

export function createSessionService(
	options: SessionServiceOptions,
): SessionService {
	return new SessionService(options);
}
