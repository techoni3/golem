import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ManagedCodexRpcMessage {
	readonly id?: number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

export interface ManagedCodexRpcOptions {
	readonly command?: string;
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly args?: readonly string[];
	readonly requestTimeoutMs?: number;
	readonly onNotification?: (message: ManagedCodexRpcMessage) => void;
	readonly onExit?: (detail: {
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	}) => void;
}

function safeError(code: string): Error {
	return new Error(code);
}

/** JSONL App Server transport. It never uses a shell and redacts process text. */
export class ManagedCodexRpc {
	readonly child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	readonly #waiters = new Set<{
		predicate: (message: ManagedCodexRpcMessage) => boolean;
		resolve: (message: ManagedCodexRpcMessage) => void;
		timer: NodeJS.Timeout;
	}>();
	readonly #timeout: number;
	readonly #onNotification:
		| ((message: ManagedCodexRpcMessage) => void)
		| undefined;
	#nextId = 1;
	#closed = false;

	constructor(options: ManagedCodexRpcOptions) {
		this.#timeout = options.requestTimeoutMs ?? 30_000;
		this.#onNotification = options.onNotification;
		const args = [...(options.args ?? ["app-server", "--listen", "stdio://"])];
		this.child = spawn(options.command ?? "codex", args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.resume();
		this.child.on("error", () =>
			this.#failAll(safeError("adapter.codex.managed.process_failed")),
		);
		this.child.on("exit", (code, signal) => {
			this.#failAll(safeError("adapter.codex.managed.process_exited"));
			options.onExit?.({ code, signal });
		});
		createInterface({ input: this.child.stdout }).on("line", (line) =>
			this.#receive(line),
		);
	}

	#receive(line: string): void {
		let message: ManagedCodexRpcMessage;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object") throw new Error("invalid");
			message = parsed as ManagedCodexRpcMessage;
		} catch {
			this.#failAll(safeError("adapter.codex.managed.protocol_invalid"));
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error !== undefined)
				pending.reject(safeError("adapter.codex.managed.request_rejected"));
			else pending.resolve(message.result);
			return;
		}
		for (const waiter of this.#waiters) {
			if (!waiter.predicate(message)) continue;
			this.#waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
		// Notifications are advisory; the canonical ingress remains the
		// supervisor's injected service. Never persist raw App Server payloads.
		// The callback is invoked after waiter resolution so a delivery completion
		// cannot race the request that established its idempotency claim.
		this.#onNotification?.(message);
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		for (const waiter of this.#waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ method: "codex.managed.process_exited" });
		}
		this.#waiters.clear();
	}

	request(
		method: string,
		params: unknown = {},
		timeoutMs = this.#timeout,
	): Promise<unknown> {
		if (this.#closed || this.child.exitCode !== null)
			return Promise.reject(
				safeError("adapter.codex.managed.process_unavailable"),
			);
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(safeError("adapter.codex.managed.request_timeout"));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			try {
				this.child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			} catch {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(safeError("adapter.codex.managed.process_unavailable"));
			}
		});
	}

	notify(method: string, params: unknown = {}): void {
		if (this.#closed || this.child.exitCode !== null)
			throw safeError("adapter.codex.managed.process_unavailable");
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	waitFor(
		predicate: (message: ManagedCodexRpcMessage) => boolean,
		timeoutMs = this.#timeout,
	): Promise<ManagedCodexRpcMessage> {
		return new Promise((resolve) => {
			const waiter = {
				predicate,
				resolve,
				timer: setTimeout(() => {
					this.#waiters.delete(waiter);
					resolve({ method: "codex.managed.wait_timeout" });
				}, timeoutMs),
			};
			this.#waiters.add(waiter);
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#failAll(safeError("adapter.codex.managed.process_closed"));
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			let force: NodeJS.Timeout | undefined;
			const finish = () => {
				if (force) clearTimeout(force);
				resolve();
			};
			this.child.once("exit", finish);
			force = setTimeout(() => {
				try {
					this.child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 5_000);
			try {
				this.child.kill("SIGTERM");
			} catch {
				finish();
			}
		});
	}
}
