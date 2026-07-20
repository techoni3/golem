import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { createRuntimeMaterializer, RuntimeInbox } from "@golem/runtime";

const home = process.env.GOLEM_RUNTIME_TEST_HOME;
const runtimePath = process.env.GOLEM_RUNTIME_TEST_DB;
const trackerPath = process.env.GOLEM_RUNTIME_TEST_TRACKER_DB;
const failpoint = process.env.GOLEM_RUNTIME_TEST_FAILPOINT;

if (!home || !runtimePath || !trackerPath || !failpoint)
	throw new Error("runtime crash fixture requires temporary home, database paths, and a failpoint");

if (failpoint === "before_publish") {
	const signal = JSON.parse(process.env.GOLEM_RUNTIME_TEST_SIGNAL || "null");
	const inbox = new RuntimeInbox(home, {
		afterTemporaryFsync: () => process.exit(73),
	});
	inbox.accept(signal);
	throw new Error("runtime producer crash fixture did not stop before publish");
}

const owner = openControlPlanePersistence({ runtimePath, trackerPath });
const { materializer } = createRuntimeMaterializer({ home, writer: owner });
try {
	materializer.drain({ limit: 1, failpoint });
	throw new Error(`runtime crash fixture did not hit ${failpoint}`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	// Intentionally do not close the owner. This is the crash boundary under
	// test: a restarted service must safely replace the dead owner's lock.
	process.exitCode = 74;
}
