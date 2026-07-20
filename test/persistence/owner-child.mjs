import {
	PersistenceOwnerConflictError,
	openPersistenceForControlPlane,
} from "@golem/persistence";

const paths = {
	runtimePath: process.env.GOLEM_RUNTIME_DB,
	trackerPath: process.env.GOLEM_TRACKER_DB,
};

if (!paths.runtimePath || !paths.trackerPath)
	throw new Error("owner-child requires temporary runtime and tracker paths");

let owner;
try {
	owner = openPersistenceForControlPlane(paths, process.env.GOLEM_OWNER_ID || "journey-child");
	process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
} catch (error) {
	if (error instanceof PersistenceOwnerConflictError) {
		process.stderr.write(`${JSON.stringify({ type: "owner_conflict", diagnostic: error.diagnostic })}\n`);
		process.exitCode = 41;
	} else {
		throw error;
	}
}

async function closeAndExit() {
	if (owner) await owner.close();
	process.exit(0);
}

if (owner) {
	process.once("SIGTERM", () => void closeAndExit());
	process.once("SIGINT", () => void closeAndExit());
	setInterval(() => undefined, 1_000);
}
