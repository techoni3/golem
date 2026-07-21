#!/usr/bin/env node
import { stableSummaryJson, summarizeJourneys } from "@golem/testkit";

import { diagnosticFor, exercises, isLoopbackUnavailable } from "./exercise.mjs";
import { scenarios } from "./scenarios.mjs";

const arguments_ = process.argv.slice(2);
const selectorIndex = arguments_.indexOf("--scenario");
const requestedId = selectorIndex === -1 ? undefined : arguments_[selectorIndex + 1];
const targetIndex = arguments_.indexOf("--target");
const requestedTarget = targetIndex === -1 ? undefined : arguments_[targetIndex + 1];

if (arguments_.includes("--list")) {
	for (const scenario of scenarios) process.stdout.write(`${scenario.id}\t${scenario.journey}\t${scenario.tier}\t${scenario.regression}\n`);
	process.exit(0);
}
if (selectorIndex !== -1 && !requestedId) throw new Error("--scenario requires a scenario id");
if (targetIndex !== -1 && !requestedTarget) throw new Error("--target requires a target id");
const allowedArguments = new Set(["--scenario", requestedId, "--target", requestedTarget]);
if (arguments_.some((argument) => !allowedArguments.has(argument)))
	throw new Error(`unknown journey runner argument: ${arguments_.find((argument) => !allowedArguments.has(argument))}`);

const targetScenarios = {
	opencode: new Set([
		"render-mcp-closure",
		"opencode-provider-coexistence",
		"opencode-resume-bridge-recovery",
	]),
};
if (requestedTarget && !targetScenarios[requestedTarget])
	throw new Error(`unknown journey target: ${requestedTarget}`);
const selected = (requestedId ? scenarios.filter((scenario) => scenario.id === requestedId) : scenarios)
	.filter((scenario) => !requestedTarget || targetScenarios[requestedTarget].has(scenario.id));
if (requestedId && selected.length === 0) throw new Error(`unknown journey scenario: ${requestedId}`);

const results = [];
for (const scenario of selected) {
	const exercise = exercises[scenario.id];
	if (!exercise) throw new Error(`no journey implementation is registered for ${scenario.id}`);
	try {
		const evidence = await exercise(requestedTarget);
		results.push({ ...scenario, status: "PASS", evidence });
	} catch (error) {
		const loopbackGate = isLoopbackUnavailable(error);
		results.push({
			...scenario,
			status: loopbackGate ? "UNMET" : "FAIL",
			evidence: loopbackGate
				? "sandbox rejected the real 127.0.0.1 listener (EPERM); real-boundary lifecycle is UNMET and no PASS is implied"
				: diagnosticFor(error),
		});
	}
}

const summary = summarizeJourneys(results);
process.stdout.write(stableSummaryJson(summary));
process.exitCode = summary.overall === "PASS" ? 0 : summary.overall === "UNMET" ? 2 : 1;
