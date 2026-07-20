import { createRequire } from "node:module";

const trackerPath = process.env.GOLEM_TRACKER_DB;
const now = process.env.GOLEM_TRACKER_FIXTURE_NOW;
const worker = process.env.GOLEM_TRACKER_FIXTURE_WORKER ?? "delivery-child";
if (!trackerPath || !now) process.exit(64);

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const database = new Database(trackerPath);
database.pragma("busy_timeout = 1000");
try {
	database.exec("BEGIN IMMEDIATE");
	const candidate = database
		.prepare("SELECT id FROM tracker_envelopes WHERE status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id LIMIT 1")
		.get(now);
	let claimed = false;
	if (candidate) {
		claimed = database
			.prepare("UPDATE tracker_envelopes SET status = 'claimed', attempts = attempts + 1, claim_owner = ?, claim_token = ?, claim_until = ? WHERE id = ? AND status IN ('pending', 'retrying')")
			.run(worker, `${worker}-token`, new Date(Date.parse(now) + 5000).toISOString(), candidate.id).changes === 1;
	}
	database.exec("COMMIT");
	process.stdout.write(`${JSON.stringify({ claimed, id: candidate?.id ?? null, worker })}\n`);
} catch (error) {
	try { database.exec("ROLLBACK"); } catch {}
	process.stdout.write(`${JSON.stringify({ claimed: false, busy: true, worker, error: error instanceof Error ? error.code : "unknown" })}\n`);
} finally {
	database.close();
}
