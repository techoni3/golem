import path from "node:path";

import {
	createRuntimeMaterializer,
	RuntimeEngineScheduler,
	RuntimeOutboxDrainer,
} from "@golem/runtime";
import { openControlPlanePersistence } from "./persistence.js";
import {
	controlPlanePortFromEnvironment,
	startControlPlane,
} from "./server.js";

const token = process.env.GOLEM_CONTROL_PLANE_TOKEN;
const golemHome = process.env.GOLEM_HOME;
const stateDirectory = golemHome
	? path.join(golemHome, "control-plane")
	: undefined;
const staticDirectory = process.env.GOLEM_CONTROL_PLANE_STATIC_ROOT;
const replayWindowValue = Number(process.env.GOLEM_CONTROL_PLANE_REPLAY_WINDOW);
const replayWindowSize =
	Number.isInteger(replayWindowValue) && replayWindowValue >= 1
		? replayWindowValue
		: undefined;
// Test-only seam: omit the projection port unless a valid revision is
// explicitly supplied. Normal composition therefore keeps lifecycle's
// persisted/default projection path instead of replacing it with an empty
// fixture projection.
const projectionRevisionRaw =
	process.env.GOLEM_CONTROL_PLANE_PROJECTION_REVISION;
const projectionRevisionValue =
	projectionRevisionRaw === undefined
		? undefined
		: Number(projectionRevisionRaw);
const projectionFixtureRaw = process.env.GOLEM_CONTROL_PLANE_PROJECTION_FIXTURE;
let projectionFixture: Record<string, unknown> | undefined;
if (projectionFixtureRaw) {
	try {
		const parsed: unknown = JSON.parse(projectionFixtureRaw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			projectionFixture = parsed as Record<string, unknown>;
	} catch {
		// Invalid test fixtures fail closed to the normal lifecycle projection.
	}
}
const projectionRevision =
	projectionRevisionValue !== undefined &&
	Number.isInteger(projectionRevisionValue) &&
	projectionRevisionValue >= 0
		? projectionRevisionValue
		: 0;
const testProjection =
	projectionFixture !== undefined ||
	(projectionRevisionValue !== undefined &&
		Number.isInteger(projectionRevisionValue) &&
		projectionRevisionValue >= 0)
		? {
				projection: {
					read: () => projectionFixture ?? {},
					revision: () => projectionRevision,
				},
			}
		: {};

if (!token || !golemHome || !stateDirectory || !staticDirectory) {
	process.stderr.write(
		"GOLEM_CONTROL_PLANE_TOKEN, GOLEM_HOME, and GOLEM_CONTROL_PLANE_STATIC_ROOT are required\n",
	);
	process.exitCode = 64;
} else {
	const owner = openControlPlanePersistence({
		runtimePath: path.join(golemHome, "runtime.db"),
		trackerPath: path.join(golemHome, "tracker.db"),
	});
	const runtime = createRuntimeMaterializer({ home: golemHome, writer: owner });
	const outbox = new RuntimeOutboxDrainer({
		writer: owner,
		workerId: `control-plane-${process.pid}`,
		destinations: {
			// Wave 5 intentionally has no tracker/management transport adapter.
			// The bounded durable scheduler records retry/permanent state rather
			// than pretending this cross-store delivery is already atomic.
			tracker: {
				deliver: async () => {
					throw new Error("runtime tracker destination is not configured");
				},
			},
			management: {
				deliver: async () => {
					throw new Error("runtime management destination is not configured");
				},
			},
		},
	});
	const scheduler = new RuntimeEngineScheduler({
		materializer: runtime.materializer,
		outbox,
		writer: owner,
	});
	try {
		await scheduler.start();
	} catch (error) {
		await owner.close();
		throw error;
	}
	let service: Awaited<ReturnType<typeof startControlPlane>>;
	try {
		service = await startControlPlane({
			token,
			stateDirectory,
			staticDirectory,
			port: controlPlanePortFromEnvironment(
				process.env.GOLEM_CONTROL_PLANE_PORT,
			),
			runtimeIngress: runtime.inbox,
			runtimeHealth: scheduler,
			...(replayWindowSize ? { replayWindowSize } : {}),
			...testProjection,
		});
	} catch (error) {
		await scheduler.stop();
		await owner.close();
		throw error;
	}
	process.stdout.write(
		`${JSON.stringify({ type: "ready", origin: service.origin, instance_id: service.instanceId })}\n`,
	);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await scheduler.stop();
		await service.close();
		await owner.close();
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
}
