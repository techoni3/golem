import { spawnSync } from "node:child_process";
import type { OpenCodeProvider, OpenCodeProviderObservation } from "./types.js";

export interface OpenCodeProbeRecord {
	readonly command: "opencode" | "ollama";
	readonly available: boolean;
	readonly version?: string;
	readonly observedAt: string;
}

export interface OpenCodeProviderProbe {
	readonly observations: readonly OpenCodeProviderObservation[];
	readonly records: readonly OpenCodeProbeRecord[];
}

type ProbeRun = (
	command: string,
	arguments_: readonly string[],
) => {
	readonly status: number | null;
	readonly stdout: string;
};

function versionFrom(value: string): string | undefined {
	const match = value.match(/\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/u);
	return match?.[0];
}

function defaultRun(command: string, arguments_: readonly string[]) {
	const result = spawnSync(command, arguments_, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
	});
	return { status: result.status, stdout: String(result.stdout ?? "") };
}

function probe(
	command: "opencode" | "ollama",
	now: string,
	run: ProbeRun,
): OpenCodeProbeRecord {
	const result = run(command, ["--version"]);
	const version = versionFrom(result.stdout);
	return {
		command,
		available: result.status === 0,
		...(version ? { version } : {}),
		observedAt: now,
	};
}

/**
 * Record only observable binary/daemon/credential-presence facts. It never
 * serializes credential values and never promotes a preflight into response or
 * prompt-consumption evidence.
 */
export function probeOpenCodeProviders(
	input: {
		readonly now?: () => string;
		readonly environment?: Readonly<Record<string, string | undefined>>;
		readonly run?: ProbeRun;
	} = {},
): OpenCodeProviderProbe {
	const now = (input.now ?? (() => new Date().toISOString()))();
	const environment = input.environment ?? process.env;
	const run = input.run ?? defaultRun;
	const opencode = probe("opencode", now, run);
	const ollama = probe("ollama", now, run);
	const localStatus = ollama.available
		? run("ollama", ["list"]).status === 0
		: false;
	const observation = (
		provider: OpenCodeProvider,
		values: Pick<
			OpenCodeProviderObservation,
			"available" | "credentials" | "daemon" | "modelPattern"
		>,
	): OpenCodeProviderObservation => ({
		provider,
		...values,
		...(opencode.version ? { version: opencode.version } : {}),
		responseObserved: false,
		deliveryObserved: false,
		evidenceSource: "manual_probe",
		evidencePolicy: "observed",
		observedAt: now,
	});
	return {
		records: [opencode, ollama],
		observations: [
			observation("openai", {
				available: opencode.available,
				credentials: Boolean(environment.OPENAI_API_KEY),
				daemon: false,
				modelPattern: "gpt-*",
			}),
			observation("ollama_cloud", {
				available: opencode.available,
				credentials: Boolean(environment.OLLAMA_API_KEY),
				daemon: false,
				modelPattern: "*",
			}),
			observation("ollama_local", {
				available: opencode.available && localStatus,
				credentials: false,
				daemon: localStatus,
				modelPattern: "*",
			}),
		],
	};
}
