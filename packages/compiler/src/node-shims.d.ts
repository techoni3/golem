declare module "node:*" {
	// biome-ignore lint/suspicious/noExplicitAny: the workspace intentionally avoids a second Node type package.
	const nodeModule: any;
	export default nodeModule;
}
