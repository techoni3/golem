import type {
	BrowserControlPlaneClient,
	ControlPlaneStream,
} from "./index.js";

type Frame = ReturnType<BrowserControlPlaneClient["parseWebSocketFrame"]>;

export type ProjectionConnectionState =
	| "connecting"
	| "connected"
	| "disconnected"
	| "resyncing"
	| "error";

export interface ProjectionSocket {
	close(): void;
	onclose: ((event?: unknown) => void) | null;
	onerror: ((event?: unknown) => void) | null;
	onmessage: ((event: { readonly data: string }) => void) | null;
	onopen: (() => void) | null;
}

export interface ProjectionSynchronizer {
	start(): void;
	stop(): void;
}

export type ProjectionSnapshot = Awaited<
	ReturnType<BrowserControlPlaneClient["projection"]>
>;

/**
 * Owns one authoritative socket epoch. A gap discards every outstanding socket
 * callback before refetching the HTTP snapshot, so stale close/message events
 * cannot schedule a second reconnect or merge a mixed generation.
 */
export function createProjectionSynchronizer(options: {
	readonly client: BrowserControlPlaneClient;
	readonly stream: ControlPlaneStream;
	readonly socketFactory?: (url: string) => ProjectionSocket;
	readonly onDelta: (frame: Frame) => void;
	readonly onSnapshot: (
		snapshot: ProjectionSnapshot,
		source: "http" | "ws",
	) => void;
	readonly onState: (state: ProjectionConnectionState) => void;
	readonly retryDelayMs?: number;
	readonly maxRetryDelayMs?: number;
}): ProjectionSynchronizer {
	const socketFactory: (url: string) => ProjectionSocket =
		options.socketFactory ??
		((url: string) => new WebSocket(url) as unknown as ProjectionSocket);
	const initialRetryDelayMs = options.retryDelayMs ?? 250;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? 4_000;
	let retryDelayMs = initialRetryDelayMs;
	let stopped = false;
	let resyncing = false;
	let socket: ProjectionSocket | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let epoch = 0;
	let cursor:
		| { readonly instanceId: string; readonly sequence: number }
		| undefined;

	const clearRetry = () => {
		if (retry !== undefined) clearTimeout(retry);
		retry = undefined;
	};

	const owns = (candidate: ProjectionSocket, candidateEpoch: number) =>
		!stopped && !resyncing && epoch === candidateEpoch && socket === candidate;

	const resetBackoff = () => {
		retryDelayMs = initialRetryDelayMs;
	};

	const scheduleReconnect = () => {
		if (stopped || resyncing || retry !== undefined) return;
		options.onState("disconnected");
		const delay = retryDelayMs;
		retryDelayMs = Math.min(maxRetryDelayMs, retryDelayMs * 2);
		retry = setTimeout(() => {
			retry = undefined;
			connect(false);
		}, delay);
	};

	const discardSocket = () => {
		const previous = socket;
		socket = undefined;
		if (previous) previous.close();
	};

	const applySnapshotFrame = (frame: Frame) => {
		if (frame.payload.kind !== "snapshot") return;
		cursor = { instanceId: frame.instance_id, sequence: frame.sequence };
		options.onSnapshot(
			{
				schema_version: "golem.control-plane-projection/v1",
				stream: options.stream,
				resource_revision: frame.resource_revision,
				payload: frame.payload.payload as ProjectionSnapshot["payload"],
			},
			"ws",
		);
		resetBackoff();
		options.onState("connected");
	};

	const resync = () => {
		if (stopped || resyncing) return;
		resyncing = true;
		clearRetry();
		const resyncEpoch = ++epoch;
		discardSocket();
		options.onState("resyncing");
		void options.client
			.projection(options.stream)
			.then((snapshot) => {
				if (stopped || epoch !== resyncEpoch) return;
				options.onSnapshot(snapshot, "http");
				cursor = undefined;
				resyncing = false;
				resetBackoff();
				connect(true);
			})
			.catch(() => {
				if (stopped || epoch !== resyncEpoch) return;
				resyncing = false;
				options.onState("error");
				scheduleReconnect();
			});
	};

	const handleFrame = (frame: Frame) => {
		if (resyncing || frame.stream !== options.stream) return;
		if (frame.payload.kind === "resync_required") {
			resync();
			return;
		}
		if (frame.payload.kind === "snapshot") {
			applySnapshotFrame(frame);
			return;
		}
		if (!cursor || cursor.instanceId !== frame.instance_id) {
			resync();
			return;
		}
		if (frame.sequence <= cursor.sequence) return;
		if (frame.sequence !== cursor.sequence + 1) {
			resync();
			return;
		}
		cursor = { instanceId: frame.instance_id, sequence: frame.sequence };
		options.onDelta(frame);
		resetBackoff();
		options.onState("connected");
	};

	function connect(forceSnapshot: boolean): void {
		if (stopped || resyncing || socket) return;
		clearRetry();
		const socketEpoch = ++epoch;
		options.onState("connecting");
		let next: ProjectionSocket;
		try {
			next = socketFactory(
				options.client.webSocketUrl(
					options.stream,
					forceSnapshot ? undefined : cursor,
				),
			);
		} catch {
			if (!stopped && epoch === socketEpoch) scheduleReconnect();
			return;
		}
		socket = next;
		next.onopen = () => {
			if (owns(next, socketEpoch)) options.onState("connecting");
		};
		next.onmessage = (event: { readonly data: string }) => {
			if (!owns(next, socketEpoch)) return;
			try {
				handleFrame(options.client.parseWebSocketFrame(event.data));
			} catch {
				resync();
			}
		};
		next.onerror = () => {
			if (!owns(next, socketEpoch)) return;
			socket = undefined;
			next.close();
			scheduleReconnect();
		};
		next.onclose = () => {
			if (!owns(next, socketEpoch)) return;
			socket = undefined;
			scheduleReconnect();
		};
	}

	return Object.freeze({
		start: () => {
			if (!stopped && (socket || resyncing)) return;
			stopped = false;
			connect(false);
		},
		stop: () => {
			stopped = true;
			resyncing = false;
			clearRetry();
			++epoch;
			discardSocket();
		},
	});
}
