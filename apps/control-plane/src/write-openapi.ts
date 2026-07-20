import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableOpenApiJson } from "./openapi.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(sourceDirectory, "../generated/openapi.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, stableOpenApiJson(), "utf8");
process.stdout.write(`wrote ${path.relative(process.cwd(), output)}\n`);
