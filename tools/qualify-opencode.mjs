import { openCodeProviderCapabilities } from "@golem/adapter-opencode";

const now = "2026-07-21T00:00:00.000Z";
const observations = [
	{
		provider: "openai",
		available: true,
		credentials: true,
		daemon: false,
		responseObserved: true,
		deliveryObserved: true,
		version: "1.0.0",
		observedAt: now,
	},
	{
		provider: "ollama_cloud",
		available: true,
		credentials: true,
		daemon: false,
		responseObserved: true,
		deliveryObserved: true,
		version: "1.0.0",
		observedAt: now,
	},
	{
		provider: "ollama_local",
		available: false,
		credentials: false,
		daemon: false,
		responseObserved: false,
		deliveryObserved: false,
		version: "1.0.0",
		observedAt: now,
	},
];
const capabilities = openCodeProviderCapabilities(observations);
const result = {
	harness: "opencode",
	observedAt: now,
	capabilities: capabilities.map((entry) => ({
		id: entry.capability.capability_id,
		backend: entry.backend,
		qualification: entry.capability.qualification,
		launchContribution: entry.launchContribution?.status,
		deliveryFlow: entry.deliveryFlow,
	})),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
