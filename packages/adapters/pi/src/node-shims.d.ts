declare module "node:*" {
	// The workspace keeps its Node boundary structural rather than importing a
	// second package-local Node type graph.
	// biome-ignore lint/suspicious/noExplicitAny: this mirrors the workspace's structural Node boundary.
	const nodeModule: any;
	export default nodeModule;
}
