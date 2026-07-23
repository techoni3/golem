import {
	createBrowserControlPlaneClient,
	createBrowserWorkSynchronizer,
} from "../../../packages/api-client/dist/index.js";

const client = createBrowserControlPlaneClient(globalThis.location.origin);
const projections = new Map();
const synchronizers = new Map();
const controllers = new Map();
const events = [];
const commands = [];
let detail;
let ready = false;

function boundedEvent(event) {
	events.push(Object.freeze(event));
	if (events.length > 80) events.splice(0, events.length - 80);
}

function safeFailure(error) {
	return Object.freeze({
		name: error instanceof Error ? error.name : "Error",
		status:
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			Number.isInteger(error.status)
				? error.status
				: 0,
	});
}

function setText(id, value) {
	const element = document.getElementById(id);
	if (element) element.textContent = value;
}

function renderBoard() {
	const list = document.getElementById("board-items");
	if (!list) return;
	list.replaceChildren();
	const board = projections.get("tracker.board");
	for (const item of board?.items ?? []) {
		const row = document.createElement("li");
		row.dataset.ticketId = item.opaque_id;
		row.dataset.revision = String(item.revision);
		const id = document.createElement("code");
		id.textContent = item.opaque_id;
		const facts = document.createElement("span");
		facts.textContent = ` · ${item.kind} · ${item.phase} · revision ${item.revision}`;
		row.append(id, facts);
		list.append(row);
	}
}

function renderDetail() {
	setText(
		"detail-item",
		detail
			? `${detail.item.opaque_id} · ${detail.item.kind} · ${detail.item.phase} · revision ${detail.item.revision}`
			: "No detail selected.",
	);
}

function renderOperations() {
	const list = document.getElementById("operation-items");
	if (!list) return;
	list.replaceChildren();
	const projection = projections.get("communication.operations");
	for (const item of projection?.items ?? []) {
		const row = document.createElement("li");
		row.dataset.operationId = item.opaque_id;
		row.dataset.operationKind = item.operation_kind;
		if (item.operation_kind === "dispatch") {
			row.dataset.disposition = item.disposition;
			row.dataset.settlement = item.settlement ?? "";
			row.textContent = `${item.opaque_id} · dispatch · ${item.disposition} · ${item.settlement ?? "unsettled"}`;
		} else {
			row.textContent = `${item.opaque_id} · ${item.operation_kind} · ${item.status}`;
		}
		list.append(row);
	}
}

function render() {
	renderBoard();
	renderDetail();
	renderOperations();
	const status = document.getElementById("work-status");
	if (status) {
		status.dataset.ready = ready ? "true" : "false";
		status.textContent = ready
			? "Authoritative browser client ready."
			: "Bootstrapping authoritative browser session…";
	}
	for (const [stream, id] of [
		["tracker.tree", "board-connection"],
		["communication.operations", "operations-connection"],
	]) {
		const connection = controllers.get(stream)?.status ?? "connecting";
		const element = document.getElementById(id);
		if (element) {
			element.dataset.connection = connection;
			element.textContent = connection;
		}
	}
}

async function refresh(stream) {
	const snapshot = await client.browserWorkProjection(stream);
	projections.set(stream, snapshot);
	boundedEvent({
		kind: "snapshot",
		stream,
		source: "http",
		revision: snapshot.resource_revision,
	});
	render();
	return snapshot;
}

function synchronizerFor(stream) {
	let synchronizer = synchronizers.get(stream);
	if (synchronizer) return synchronizer;
	synchronizer = createBrowserWorkSynchronizer({
		key: { kind: "stream", stream },
		async refetch() {
			const snapshot = await client.browserWorkProjection(stream);
			if (stream === "tracker.tree") await refresh("tracker.board");
			return snapshot;
		},
		onSnapshot(snapshot, source) {
			projections.set(stream, snapshot);
			boundedEvent({
				kind: "snapshot",
				stream,
				source,
				revision: snapshot.resource_revision,
			});
			render();
		},
		onInvalidation(tag) {
			boundedEvent({ kind: "invalidation", stream, tag });
		},
	});
	synchronizers.set(stream, synchronizer);
	return synchronizer;
}

function openStream(stream) {
	let controller = controllers.get(stream);
	if (!controller) {
		controller = {
			generation: 0,
			paused: false,
			retry: undefined,
			socket: undefined,
			status: "connecting",
			consume: Promise.resolve(),
		};
		controllers.set(stream, controller);
	}
	if (controller.paused) return;
	const synchronizer = synchronizerFor(stream);
	const cursor = synchronizer.state();
	const url =
		cursor.instance_id !== undefined && cursor.sequence !== undefined
			? client.browserWorkWebSocketUrl(stream, {
					instanceId: cursor.instance_id,
					sequence: cursor.sequence,
				})
			: client.browserWorkWebSocketUrl(stream);
	const generation = ++controller.generation;
	controller.status =
		cursor.instance_id === undefined ? "connecting" : "reconnecting";
	render();
	const socket = new WebSocket(url);
	controller.socket = socket;
	socket.addEventListener("open", () => {
		if (generation !== controller.generation) return;
		controller.status = "connected";
		boundedEvent({ kind: "connection", stream, status: "connected" });
		render();
	});
	socket.addEventListener("message", (message) => {
		if (generation !== controller.generation) return;
		controller.consume = controller.consume
			.then(async () => {
				if (generation !== controller.generation) return;
				await synchronizer.consume(String(message.data));
				if (
					generation === controller.generation &&
					synchronizer.state().instance_id === undefined &&
					socket.readyState === WebSocket.OPEN
				) {
					controller.status = "reconnecting";
					render();
					socket.close();
				}
			})
			.catch((error) => {
				boundedEvent({
					kind: "client_error",
					stream,
					...safeFailure(error),
				});
			});
	});
	socket.addEventListener("error", () => {
		if (generation !== controller.generation) return;
		controller.status = "reconnecting";
		render();
	});
	socket.addEventListener("close", () => {
		if (generation !== controller.generation || controller.paused) return;
		controller.status = "reconnecting";
		boundedEvent({ kind: "connection", stream, status: "reconnecting" });
		render();
		globalThis.clearTimeout(controller.retry);
		controller.retry = globalThis.setTimeout(() => openStream(stream), 100);
	});
}

function pause(stream) {
	const controller = controllers.get(stream);
	if (!controller) return;
	controller.paused = true;
	controller.generation += 1;
	globalThis.clearTimeout(controller.retry);
	controller.socket?.close();
	controller.status = "paused";
	boundedEvent({ kind: "connection", stream, status: "paused" });
	render();
}

function resume(stream) {
	const controller = controllers.get(stream);
	if (!controller) return openStream(stream);
	controller.paused = false;
	openStream(stream);
}

function publicState() {
	return structuredClone({
		ready,
		projections: Object.fromEntries(projections),
		detail,
		events,
		commands,
		synchronizers: Object.fromEntries(
			[...synchronizers].map(([stream, synchronizer]) => [
				stream,
				synchronizer.state(),
			]),
		),
		connections: Object.fromEntries(
			[...controllers].map(([stream, controller]) => [
				stream,
				controller.status,
			]),
		),
	});
}

globalThis.workControl = Object.freeze({
	state: publicState,
	async detail(opaqueId) {
		detail = await client.browserWorkDetail(opaqueId);
		render();
		return detail;
	},
	async command(input) {
		const result = await client.browserWorkCommand(input);
		commands.push(result);
		await Promise.all([
			refresh("tracker.board"),
			refresh("communication.operations"),
		]);
		return result;
	},
	pause,
	resume,
});

async function bootstrap() {
	await client.bootstrap();
	await Promise.all([
		refresh("tracker.board"),
		refresh("communication.operations"),
	]);
	openStream("tracker.tree");
	openStream("communication.operations");
	ready = true;
	render();
}

bootstrap().catch((error) => {
	boundedEvent({ kind: "client_error", stream: "bootstrap", ...safeFailure(error) });
	setText("work-status", "Browser client bootstrap failed.");
});
