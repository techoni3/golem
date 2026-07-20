import path from "node:path";

import {
	controlPlanePortFromEnvironment,
	startControlPlane,
} from "./server.js";

const token = process.env.GOLEM_CONTROL_PLANE_TOKEN;
const stateDirectory = process.env.GOLEM_HOME
	? path.join(process.env.GOLEM_HOME, "control-plane")
	: undefined;
const staticDirectory = process.env.GOLEM_CONTROL_PLANE_STATIC_ROOT;
const replayWindowValue = Number(process.env.GOLEM_CONTROL_PLANE_REPLAY_WINDOW);
const replayWindowSize =
	Number.isInteger(replayWindowValue) && replayWindowValue >= 1
		? replayWindowValue
		: undefined;

if (!token || !stateDirectory || !staticDirectory) {
	process.stderr.write(
		"GOLEM_CONTROL_PLANE_TOKEN, GOLEM_HOME, and GOLEM_CONTROL_PLANE_STATIC_ROOT are required\n",
	);
	process.exitCode = 64;
} else {
	const service = await startControlPlane({
		token,
		stateDirectory,
		staticDirectory,
		port: controlPlanePortFromEnvironment(process.env.GOLEM_CONTROL_PLANE_PORT),
		...(replayWindowSize ? { replayWindowSize } : {}),
	});
	process.stdout.write(
		`${JSON.stringify({ type: "ready", origin: service.origin, instance_id: service.instanceId })}\n`,
	);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await service.close();
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
}
