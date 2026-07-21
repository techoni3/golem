import { fileURLToPath } from "node:url";

import { startManagedCodexControl } from "./managed-codex-control.js";

function required(name: string): string {
	const value = process.env[name];
	if (!value)
		throw new Error(
			`adapter.codex.managed.host_${name.toLowerCase()}_required`,
		);
	return value;
}

function fixtureArgs(): readonly string[] | undefined {
	const raw = process.env.GOLEM_MANAGED_CODEX_ARGS_JSON;
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!Array.isArray(parsed) ||
			parsed.some((value) => typeof value !== "string")
		)
			throw new Error("invalid");
		return Object.freeze([...parsed]);
	} catch {
		throw new Error("adapter.codex.managed.host_args_invalid");
	}
}

/**
 * Foreground production host selected by `golem codex` for its default
 * managed path. It deliberately lives with control-plane composition: the
 * adapter receives only typed ports and this process alone owns the durable
 * runtime/tracker stores.
 */
export async function runManagedCodexHost(): Promise<void> {
	const rpcArgs = fixtureArgs();
	const control = await startManagedCodexControl({
		golemHome: required("GOLEM_HOME"),
		cwd: required("GOLEM_MANAGED_CODEX_CWD"),
		...(process.env.GOLEM_MANAGED_CODEX_BACKEND
			? { backend: process.env.GOLEM_MANAGED_CODEX_BACKEND }
			: {}),
		...(process.env.GOLEM_MANAGED_CODEX_MODEL
			? { model: process.env.GOLEM_MANAGED_CODEX_MODEL }
			: {}),
		...(process.env.GOLEM_MANAGED_CODEX_COMMAND
			? { command: process.env.GOLEM_MANAGED_CODEX_COMMAND }
			: {}),
		...(rpcArgs ? { rpcArgs } : {}),
		env: process.env,
	});
	process.stdout.write(
		`${JSON.stringify({
			type: "managed-codex-ready",
			generationId: control.binding.generationId,
			endpointId: control.binding.endpointId,
		})}\n`,
	);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	await control.stop();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	runManagedCodexHost().catch((error: unknown) => {
		const code =
			error instanceof Error
				? error.message
				: "adapter.codex.managed.host_failed";
		process.stderr.write(`${code}\n`);
		process.exitCode = 1;
	});
}
