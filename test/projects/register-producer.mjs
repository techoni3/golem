#!/usr/bin/env node
import fs from "node:fs";
import { RuntimeInbox } from "@golem/runtime";

const [home, cwd, producer] = process.argv.slice(2);
if (!home || !cwd || !producer) throw new Error("home, cwd, and producer are required");
const inbox = new RuntimeInbox(home);
const projectId = "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ordinal = Number.parseInt(producer, 10);
if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error("producer must be a positive integer");
const hex = ordinal.toString(16).padStart(12, "0");
const shortHex = hex.slice(-8);
const signal = {
	schema_version: "golem.runtime-signal/v1",
	event_id: `evt_${shortHex}-0000-4000-8000-${hex}`,
	event_kind: "project.observed",
	producer: "project-register-fixture",
	producer_instance_id: `prod_${shortHex}-0000-4000-8000-${hex}`,
	harness: "claude",
	correlation_id: `corr-${producer}`,
	deduplication_key: "project-register:shared",
	clocks: {
		source_observed_at: "2026-07-21T00:00:00.000Z",
		received_at: "2026-07-21T00:00:01.000Z",
	},
	provenance: { source: "adapter", confidence: "verified", evidence_id: `producer-${producer}` },
	clear_fields: [],
	payload: {
		kind: "project.observed",
		project: { project_id: projectId },
		location: { project_id: projectId, location_id: `loc_${shortHex}-0000-4000-8000-${hex}`, relation: "registered", canonical_path: fs.realpathSync(cwd) },
	},
};
const receipt = inbox.accept(signal);
process.stdout.write(`${JSON.stringify({ producer, receipt })}\n`);
