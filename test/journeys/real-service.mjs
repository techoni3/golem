#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const databasePath = process.env.TESTKIT_DB_PATH;
if (!databasePath) throw new Error("TESTKIT_DB_PATH is required");

const database = new Database(databasePath);
database.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)");
database.prepare("INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)").run();
const increment = database.prepare("UPDATE counter SET value = value + 1 WHERE id = 1");
const readCounter = () => database.prepare("SELECT value FROM counter WHERE id = 1").get().value;

const server = createServer((request, response) => {
	if (request.url === "/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true, counter: readCounter() }));
		return;
	}
	if (request.url === "/increment" && request.method === "POST") {
		increment.run();
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ counter: readCounter() }));
		return;
	}
	response.writeHead(404).end();
});
const websocket = new WebSocketServer({ server, path: "/ws" });
websocket.on("connection", (socket) => socket.send(JSON.stringify({ type: "counter", counter: readCounter() })));

let worker;
if (process.env.TESTKIT_SPAWN_WORKER === "1") {
	worker = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

const close = () => {
	try { worker?.kill("SIGTERM"); } catch { /* cleanup only */ }
	websocket.close();
	server.close(() => database.close());
};
let reportedListenerFailure = false;
const reportListenerFailure = (error) => {
	if (reportedListenerFailure) return;
	reportedListenerFailure = true;
	process.stderr.write(`real-service listener failure: ${error.code || "UNKNOWN"} ${error.message}\n`);
	try { worker?.kill("SIGTERM"); } catch { /* cleanup only */ }
	try { database.close(); } catch { /* cleanup only */ }
	process.exitCode = 1;
};
server.once("error", reportListenerFailure);
websocket.once("error", reportListenerFailure);
process.once("SIGTERM", close);
process.once("SIGINT", close);
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	process.stdout.write(`${JSON.stringify({ type: "ready", origin: `http://127.0.0.1:${address.port}`, worker_pid: worker?.pid || null })}\n`);
});
