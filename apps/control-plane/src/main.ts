import path from "node:path";

import { createRuntimeMaterializer } from "@golem/runtime";
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
	try {
		runtime.materializer.drain();
	} catch (error) {
		await owner.close();
		throw error;
	}
	const materializerTimer = setInterval(() => {
		try {
			runtime.materializer.drain();
		} catch {
			// The source remains under processing/pending for a restart or next tick;
			// do not log envelopes, payloads, or bearer material here.
			process.stderr.write("runtime materializer tick deferred\n");
		}
	}, 250);
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
			...(replayWindowSize ? { replayWindowSize } : {}),
		});
	} catch (error) {
		clearInterval(materializerTimer);
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
		clearInterval(materializerTimer);
		await service.close();
		await owner.close();
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
}
