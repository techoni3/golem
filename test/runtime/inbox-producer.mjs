import { RuntimeInbox } from "@golem/runtime";

const home = process.env.GOLEM_RUNTIME_TEST_HOME;
const encodedSignal = process.env.GOLEM_RUNTIME_TEST_SIGNAL;

if (!home || !encodedSignal)
	throw new Error("runtime inbox producer requires a temporary home and signal");

const receipt = new RuntimeInbox(home).accept(JSON.parse(encodedSignal));
process.stdout.write(`${JSON.stringify(receipt)}\n`);
