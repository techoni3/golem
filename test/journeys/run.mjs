#!/usr/bin/env node
import { stableSummaryJson, summarizeJourneys } from "@golem/testkit";

import { diagnosticFor, exercises, isLoopbackUnavailable } from "./exercise.mjs";
import { scenarios } from "./scenarios.mjs";

const arguments_ = process.argv.slice(2);
const selectorIndex = arguments_.indexOf("--scenario");
const requestedId = selectorIndex === -1 ? undefined : arguments_[selectorIndex + 1];

if (arguments_.includes("--list")) {
	for (const scenario of scenarios) process.stdout.write(`${scenario.id}\t${scenario.journey}\t${scenario.tier}\t${scenario.regression}\n`);
	process.exit(0);
}
if (selectorIndex !== -1 && !requestedId) throw new Error("--scenario requires a scenario id");
if (arguments_.some((argument) => argument !== "--scenario" && argument !== requestedId))
	throw new Error(`unknown journey runner argument: ${arguments_.find((argument) => argument !== "--scenario" && argument !== requestedId)}`);

const selected = requestedId ? scenarios.filter((scenario) => scenario.id === requestedId) : scenarios;
if (requestedId && selected.length === 0) throw new Error(`unknown journey scenario: ${requestedId}`);

const results = [];
for (const scenario of selected) {
	const exercise = exercises[scenario.id];
	if (!exercise) throw new Error(`no journey implementation is registered for ${scenario.id}`);
	try {
		const evidence = await exercise();
		results.push({ ...scenario, status: "PASS", evidence });
	} catch (error) {
		const loopbackGate = isLoopbackUnavailable(error);
		results.push({
			...scenario,
			status: loopbackGate ? "UNMET" : "FAIL",
			evidence: loopbackGate
				? "sandbox rejected the real 127.0.0.1 listener (EPERM); no product assertion was evaluated"
				: diagnosticFor(error),
		});
	}
}

const summary = summarizeJourneys(results);
process.stdout.write(stableSummaryJson(summary));
process.exitCode = summary.overall === "PASS" ? 0 : summary.overall === "UNMET" ? 2 : 1;
