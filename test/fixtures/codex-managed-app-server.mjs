#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

let threadId = "thread-managed-1";
let turn = 0;
const statePath = process.env.GOLEM_CODEX_TURN_STATE;
const delivered = (() => {
	if (!statePath) return new Map();
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
		return new Map(
			Object.entries(parsed).filter(([, value]) => typeof value === "string"),
		);
	} catch {
		return new Map();
	}
})();

function persistDelivered() {
	if (!statePath) return;
	fs.writeFileSync(statePath, `${JSON.stringify(Object.fromEntries(delivered))}\n`);
}

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	let request;
	try { request = JSON.parse(line); } catch { return; }
	if (!request || typeof request !== "object" || typeof request.id !== "number") return;
	switch (request.method) {
		case "initialize":
			reply(request.id, { userAgent: "codex-managed-fixture/1" });
			break;
		case "mcpServerStatus/list":
			reply(request.id, { servers: [{ name: "golem", status: "ready" }] });
			break;
		case "thread/start":
			threadId = "thread-managed-1";
			reply(request.id, { thread: { id: threadId, status: { type: "idle" } } });
			break;
		case "thread/resume":
			if (request.params?.threadId !== threadId) {
				process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000 } })}\n`);
			} else reply(request.id, { thread: { id: threadId, status: { type: "idle" } } });
			break;
		case "turn/start": {
			if (process.env.GOLEM_CODEX_FAIL_TURN_START === "1") {
				// J3's pre-transport crash seam: no JSON-RPC response and no turn log.
				// The caller must retain a retryable canonical envelope because no App
				// Server turn has yet been accepted.
				process.exitCode = 70;
				process.exit();
				break;
			}
			const messageId = request.params?.clientUserMessageId;
			if (typeof messageId === "string" && delivered.has(messageId)) {
				const turnId = delivered.get(messageId);
				reply(request.id, { turn: { id: turnId, status: "inProgress" } });
				break;
			}
			turn += 1;
			if (process.env.GOLEM_CODEX_TURN_LOG) fs.appendFileSync(process.env.GOLEM_CODEX_TURN_LOG, `${turn}\n`);
			const turnId = `turn-managed-${turn}`;
			if (typeof messageId === "string") {
				delivered.set(messageId, turnId);
				persistDelivered();
			}
			reply(request.id, { turn: { id: turnId, status: "inProgress" } });
			setImmediate(() => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })}\n`));
			break;
		}
		case "turn/interrupt":
		case "thread/archive":
			reply(request.id, {});
			break;
		default:
			reply(request.id, {});
	}
});
