import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const expected = new Map([
	["openapi-typescript", "7.13.0"],
	["typescript", "5.9.3"],
]);

for (const [name, version] of expected) {
	const manifest = JSON.parse(
		await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
	);
	if (manifest.version !== version) {
		throw new Error(
			`expected ${name}@${version}, found ${manifest.version ?? "missing"}`,
		);
	}
}

process.stdout.write(
	"OpenAPI codegen toolchain is isolated: TypeScript 5.9.3 + openapi-typescript 7.13.0\n",
);
