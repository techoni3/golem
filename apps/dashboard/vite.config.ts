import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));
const packageVersion = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly version: string };

/** Generated chunks are checked with `git diff --check`; Rollup preserves
 * indentation inside dependency template strings, so normalize it at the
 * compiler boundary without hand-editing emitted dashboard assets. */
const artifactWhitespace = {
	name: "golem:artifact-whitespace",
	generateBundle(
		_: unknown,
		bundle: Record<string, { type: string; code?: string }>,
	) {
		for (const output of Object.values(bundle)) {
			if (output.type === "chunk" && output.code)
				output.code = output.code.replace(/[\t ]+(?=\r?\n)/gu, "");
		}
	},
};

export default defineConfig({
	define: {
		__GOLEM_PACKAGE_VERSION__: JSON.stringify(packageVersion.version),
	},
	plugins: [react(), artifactWhitespace],
	resolve: {
		alias: {
			react: `${dashboardRoot}node_modules/react`,
			"react-dom": `${dashboardRoot}node_modules/react-dom`,
		},
	},
	build: {
		emptyOutDir: true,
		minify: "esbuild",
		outDir: "../../dashboard/dist",
		sourcemap: false,
	},
});
