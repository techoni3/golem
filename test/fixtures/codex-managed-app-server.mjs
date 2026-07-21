#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

let threadId = "thread-managed-1";
let turn = 0;

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
			turn += 1;
			if (process.env.GOLEM_CODEX_TURN_LOG) fs.appendFileSync(process.env.GOLEM_CODEX_TURN_LOG, `${turn}\n`);
			const turnId = `turn-managed-${turn}`;
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
