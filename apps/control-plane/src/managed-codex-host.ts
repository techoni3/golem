import { createInterface } from "node:readline";
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

interface ManagedCodexHostDelivery {
	readonly id: string;
	readonly text: string;
}

function parseDelivery(line: string): ManagedCodexHostDelivery {
	try {
		const parsed: unknown = JSON.parse(line);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as { type?: unknown }).type !== "delivery" ||
			typeof (parsed as { id?: unknown }).id !== "string" ||
			!(parsed as { id: string }).id.trim() ||
			typeof (parsed as { text?: unknown }).text !== "string"
		)
			throw new Error("invalid");
		return Object.freeze({
			id: (parsed as { id: string }).id,
			text: (parsed as { text: string }).text,
		});
	} catch {
		throw new Error("adapter.codex.managed.host_delivery_invalid");
	}
}

function writeEvent(event: Readonly<Record<string, unknown>>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
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
		...(process.env.GOLEM_MANAGED_CODEX_SESSION
			? { sessionId: process.env.GOLEM_MANAGED_CODEX_SESSION }
			: {}),
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
	let drainTail: Promise<void> = Promise.resolve();
	const drain = () => {
		const next = drainTail.then(() => control.drain());
		// Keep later ingress live after one transient claim or transport failure.
		drainTail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const consume = async (line: string) => {
		try {
			const delivery = parseDelivery(line);
			control.enqueue(delivery);
			const outcomes = await drain();
			writeEvent({
				type: "managed-codex-drained",
				deliveryId: delivery.id,
				outcomes,
			});
		} catch (error) {
			writeEvent({
				type: "managed-codex-delivery-failed",
				code:
					error instanceof Error
						? error.message
						: "adapter.codex.managed.host_delivery_failed",
			});
		}
	};
	input.on("line", (line) => {
		void consume(line);
	});
	// The listener is installed before readiness. This is the real foreground
	// consumer: it persists ingress through Tracker, then claims it through the
	// same canonical durable delivery service used by every producer.
	await control.startDeliveryConsumer();
	const poll = setInterval(() => {
		void drain()
			.then((outcomes) => {
				if (outcomes.length > 0)
					writeEvent({ type: "managed-codex-drained", outcomes });
			})
			.catch((error: unknown) => {
				writeEvent({
					type: "managed-codex-delivery-failed",
					code:
						error instanceof Error
							? error.message
							: "adapter.codex.managed.host_delivery_failed",
				});
			});
	}, 250);
	writeEvent({
		type: "managed-codex-ready",
		sessionId: control.binding.sessionId,
		generationId: control.binding.generationId,
		endpointId: control.binding.endpointId,
	});
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	clearInterval(poll);
	input.close();
	await drainTail;
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
