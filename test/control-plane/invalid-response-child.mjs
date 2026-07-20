import path from "node:path";

import { startControlPlane } from "../../apps/control-plane/dist/index.js";

const token = process.env.GOLEM_CONTROL_PLANE_TOKEN;
const golemHome = process.env.GOLEM_HOME;
const staticDirectory = process.env.GOLEM_CONTROL_PLANE_STATIC_ROOT;

if (!token || !golemHome || !staticDirectory)
	throw new Error("invalid-response child requires isolated control-plane environment");

const service = await startControlPlane({
	token,
	stateDirectory: path.join(golemHome, "invalid-response-control-plane"),
	staticDirectory,
	port: 0,
	invalidResponseForTest: true,
});
process.stdout.write(`${JSON.stringify({ type: "ready", origin: service.origin })}\n`);

let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	await service.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
