import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			react: `${dashboardRoot}node_modules/react`,
			"react-dom": `${dashboardRoot}node_modules/react-dom`,
		},
	},
	build: {
		emptyOutDir: true,
		outDir: "dist/assets",
		sourcemap: true,
	},
});
