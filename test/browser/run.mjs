#!/usr/bin/env node
import { exerciseControlPlaneShell } from "../control-plane/control-plane-shell.mjs";

const arguments_ = process.argv.slice(2);
const grepIndex = arguments_.indexOf("--grep");
const grep = grepIndex === -1 ? undefined : arguments_[grepIndex + 1];
if (grep !== "control-plane-shell" || arguments_.length !== 2)
	throw new Error("use --grep control-plane-shell");

await exerciseControlPlaneShell();
process.stdout.write("control-plane-shell PASS\n");
