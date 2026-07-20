import { createRequire } from "node:module";

const databasePath = process.env.GOLEM_RUNTIME_CONSUMER_DB;
const deliveryId = process.env.GOLEM_RUNTIME_CONSUMER_ID;
const payload = process.env.GOLEM_RUNTIME_CONSUMER_PAYLOAD;
const crashAfterWrite = process.env.GOLEM_RUNTIME_CONSUMER_CRASH_AFTER_WRITE === "1";

if (!databasePath || !deliveryId || payload === undefined)
	throw new Error("runtime outbox consumer fixture requires database, id, and payload");

const require = createRequire(
	new URL("../../packages/persistence/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const database = new Database(databasePath);
try {
	database
		.prepare("INSERT OR IGNORE INTO deliveries(id, payload_json) VALUES (?, ?)")
		.run(deliveryId, payload);
} finally {
	database.close();
}

if (crashAfterWrite) process.exit(75);
