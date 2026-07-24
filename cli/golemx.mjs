#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "release", "golem-cli.mjs");
const { runCli } = await import(pathToFileURL(entry).href);
process.exitCode = await runCli(["opencode", ...process.argv.slice(2)]);
