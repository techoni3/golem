import { createBrowserPrincipalResolver } from "../../apps/control-plane/dist/auth.js";

export function provisionBearerPrincipal(
	writer,
	{
		token,
		projectId,
		actorId,
		bindingId,
		clock,
	},
) {
	const principals = writer.browserPrincipalStorage();
	principals.provision({
		id: bindingId,
		actorId,
		role: "operator",
		defaultProjectId: projectId,
		scopeProjectIds: [projectId],
	});
	principals.bindCredential({
		bindingId,
		adapter: "bearer",
		credential: token,
	});
	return createBrowserPrincipalResolver({
		storage: principals,
		...(clock ? { clock } : {}),
	});
}
