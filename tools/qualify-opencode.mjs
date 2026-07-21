import {
	openCodeProviderCapabilities,
	probeOpenCodeProviders,
} from "@golem/adapter-opencode";

const probe = probeOpenCodeProviders();
const capabilities = openCodeProviderCapabilities(probe.observations);
const result = {
	harness: "opencode",
	observedAt: probe.records[0]?.observedAt ?? new Date().toISOString(),
	probes: probe.records,
	capabilities: capabilities.map((entry) => ({
		id: entry.capability.capability_id,
		backend: entry.backend,
		qualification: entry.capability.qualification,
		launchContribution: entry.launchContribution?.status,
		deliveryFlow: entry.deliveryFlow,
	})),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
