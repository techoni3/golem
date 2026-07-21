import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { createRuntimeMaterializer, createSessionService } from "@golem/runtime";
import { openCodeRuntimeProjectId } from "@golem/adapter-opencode";
import { createTemporaryHome, waitFor } from "@golem/testkit";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const privateRuntimeKeys = [
	"GOLEM_RUNTIME_PROJECT_ID",
	"GOLEM_RUNTIME_PROJECT_PATH",
	"GOLEM_CONTROL_PLANE_URL",
	"GOLEM_CONTROL_PLANE_TOKEN",
	"GOLEM_OPENCODE_DELIVERY_MODE",
];

function directLaunchEnvironment(home, bin) {
	const environment = {
		...process.env,
		...home.env,
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		OPENAI_API_KEY: "gol48-normal-launch-test-key",
	};
	for (const key of privateRuntimeKeys) delete environment[key];
	return environment;
}

function writeFakeOpenCode({ bin, hostRecord }) {
	const executable = path.join(bin, "opencode");
	const shim = path.join(repositoryRoot, "shims/opencode/index.js");
	fs.writeFileSync(
		executable,
		`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[2] === "--version") {
  process.stdout.write("opencode 1.2.3\\n");
  process.exit(0);
}
const proof = {
  argv: process.argv.slice(2),
  runtime: {
    project: Boolean(process.env.GOLEM_RUNTIME_PROJECT_ID),
    projectPath: Boolean(process.env.GOLEM_RUNTIME_PROJECT_PATH),
    origin: Boolean(process.env.GOLEM_CONTROL_PLANE_URL),
    token: Boolean(process.env.GOLEM_CONTROL_PLANE_TOKEN),
    deliveryMode: process.env.GOLEM_OPENCODE_DELIVERY_MODE || null,
  },
  promptCalls: 0,
};
const { default: shim } = await import(pathToFileURL(${JSON.stringify(shim)}).href);
const hooks = await shim({
  directory: process.cwd(),
  client: {
    session: {
      promptAsync: async () => {
        proof.promptCalls += 1;
        return { response: { ok: true } };
      },
    },
  },
});
await hooks.event({
  event: {
    type: "session.created",
    properties: {
      info: {
        id: "opencode-normal-launch-session",
        directory: process.cwd(),
        title: "Normal direct OpenCode",
        model: "gpt-normal-launch",
        time: { created: Date.now() },
      },
    },
  },
});
const bridges = path.join(process.env.GOLEM_HOME, "opencode-bridges.json");
let bridge = null;
for (let attempt = 0; attempt < 40 && !bridge; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  try {
    bridge = JSON.parse(fs.readFileSync(bridges, "utf8")).bridges
      ?.find((entry) => entry.session_id === "opencode-normal-launch-session") || null;
  } catch {}
}
if (!bridge) throw new Error("normal launch did not register an OpenCode bridge");
const unfenced = await fetch("http://127.0.0.1:" + bridge.port + "/push", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    delivery_id: "del-normal-launch-unfenced",
    session_id: "opencode-normal-launch-session",
    kind: "brief",
    content: "must-not-reach-legacy-prompt",
  }),
});
proof.bridge = {
  deliveryMode: bridge.delivery_mode,
  deliveryReady: bridge.delivery_ready,
  deliveryReason: bridge.delivery_reason,
  unfencedStatus: unfenced.status,
};
await new Promise((resolve) => setTimeout(resolve, 300));
fs.writeFileSync(${JSON.stringify(hostRecord)}, JSON.stringify(proof));
await hooks.event({ event: { type: "server.instance.disposed", properties: {} } });
`,
		{ mode: 0o755 },
	);
	return executable;
}

export async function runOpenCodeNormalLaunchJourney() {
	const home = createTemporaryHome("golem-j5-opencode-normal-launch-");
	const projectRoot = fs.mkdtempSync(path.join(home.root, "project-"));
	const bin = fs.mkdtempSync(path.join(home.root, "opencode-bin-"));
	const hostRecord = path.join(home.root, "normal-launch-host.json");
	const configPath = path.join(home.xdgConfigHome, "opencode", "opencode.jsonc");
	const originalConfig = `// ordinary user configuration
{ "provider": { "user": { "baseURL": "https://example.invalid" } } }
`;
	let owner;
	try {
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, originalConfig);
		writeFakeOpenCode({ bin, hostRecord });
		const result = spawnSync(
			process.execPath,
			["cli/golem.js", "opencode", "--model", "gpt-normal-launch", "--cwd", projectRoot],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				env: directLaunchEnvironment(home, bin),
			},
		);
		assert.equal(
			result.status,
			0,
			`normal direct OpenCode launch failed: stdout=${result.stdout}; stderr=${result.stderr}`,
		);
		const host = JSON.parse(fs.readFileSync(hostRecord, "utf8"));
		assert.deepEqual(host.argv, ["--model", "gpt-normal-launch"]);
		assert.deepEqual(host.runtime, {
			project: true,
			projectPath: true,
			origin: true,
			token: true,
			deliveryMode: "pull_only",
		});
		assert.deepEqual(
			host.bridge,
			{
				deliveryMode: "pull_only",
				deliveryReady: false,
				deliveryReason: "endpoint_claim_required",
				unfencedStatus: 409,
			},
			"a normal canonical launch advertises pull-only and rejects an unfenced bridge prompt",
		);
		assert.equal(host.promptCalls, 0, "unfenced traffic never reaches legacy promptAsync");
		assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig, "direct launch does not mutate OpenCode configuration");

		owner = openControlPlanePersistence({
			runtimePath: path.join(home.golemHome, "runtime.db"),
			trackerPath: path.join(home.golemHome, "tracker.db"),
		}, { ownerId: "gol48-opencode-normal-launch-verify" });
		const runtime = createRuntimeMaterializer({
			home: home.golemHome,
			writer: owner,
			sessions: createSessionService({
				projects: owner.runtimeProjectStorage(),
				sessions: owner.runtimeSessionStorage(),
			}),
		});
		const projectId = openCodeRuntimeProjectId(projectRoot);
		const session = await waitFor(() => {
			runtime.materializer.drain();
			return owner.runtimeSessionStorage().list(projectId)[0];
		}, "normal direct OpenCode project and session materialization");
		assert.equal(session.projectId, projectId);
		assert.equal(session.metadata.name, "Normal direct OpenCode");
		return "normal direct golem opencode launch provisions a private authenticated canonical ingress and project observation without injected runtime env; it materializes the session, reports pull-only readiness, and rejects unfenced bridge traffic before promptAsync";
	} finally {
		if (owner) await owner.close();
		fs.rmSync(bin, { recursive: true, force: true });
		fs.rmSync(projectRoot, { recursive: true, force: true });
		home.cleanup();
	}
}
