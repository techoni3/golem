import {
	BrowserSettingsCommandRequestSchema,
	BrowserSettingsCommandResponseSchema,
	BrowserSettingsErrorSchema,
	BrowserSettingsSnapshotSchema,
} from "@golem/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
	type ActorContext,
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
} from "./auth.js";
import {
	BrowserSettingsServiceError,
	type BrowserSettingsServices,
} from "./browser-settings-services.js";

function jsonSchema(value: z.ZodType) {
	return z.toJSONSchema(value, {
		target: "draft-7",
		unrepresentable: "any",
		reused: "inline",
	});
}

function browserFail(
	request: FastifyRequest,
	reply: FastifyReply,
	status: 400 | 401 | 403 | 409 | 503,
	code: z.infer<typeof BrowserSettingsErrorSchema>["code"],
) {
	return reply.code(status).send(
		BrowserSettingsErrorSchema.parse({
			schema_version: "golem.browser-settings-error/v1",
			code,
			correlation_id: request.id,
		}),
	);
}

function browserContext(
	request: FastifyRequest,
	reply: FastifyReply,
	principal: BrowserPrincipalResolver,
	action: "read" | "mutate",
): ActorContext | undefined {
	if (hasRequestAuthorityOverride(request)) {
		browserFail(request, reply, 403, "browser.forbidden");
		return undefined;
	}
	const context = principal.resolve(request, {
		action,
		allowBrowser: true,
		allowBearer: false,
	});
	if (!context) {
		browserFail(request, reply, 401, "browser.auth.required");
		return undefined;
	}
	if (!principal.policy.allows(context, action)) {
		browserFail(request, reply, 403, "browser.forbidden");
		return undefined;
	}
	return context;
}

function settingsFailure(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
) {
	if (error instanceof BrowserSettingsServiceError)
		return browserFail(request, reply, error.httpStatus, error.code);
	return browserFail(request, reply, 503, "browser.settings.unavailable");
}

/** Browser-only settings surface; bearer and caller-supplied authority are denied. */
export function registerBrowserSettingsRoutes(options: {
	readonly app: FastifyInstance;
	readonly principal: BrowserPrincipalResolver;
	readonly settings: BrowserSettingsServices;
}): void {
	const errorResponses = {
		400: jsonSchema(BrowserSettingsErrorSchema),
		401: jsonSchema(BrowserSettingsErrorSchema),
		403: jsonSchema(BrowserSettingsErrorSchema),
		409: jsonSchema(BrowserSettingsErrorSchema),
		503: jsonSchema(BrowserSettingsErrorSchema),
	};

	options.app.get(
		"/api/v1/browser/settings",
		{
			schema: {
				response: {
					200: jsonSchema(BrowserSettingsSnapshotSchema),
					...errorResponses,
				},
			},
		},
		async (request, reply) => {
			if (!browserContext(request, reply, options.principal, "read")) return;
			try {
				return reply.send(await options.settings.snapshot());
			} catch (error) {
				return settingsFailure(request, reply, error);
			}
		},
	);

	options.app.post(
		"/api/v1/browser/settings/commands",
		{
			schema: {
				response: {
					200: jsonSchema(BrowserSettingsCommandResponseSchema),
					...errorResponses,
				},
			},
		},
		async (request, reply) => {
			if (!browserContext(request, reply, options.principal, "mutate")) return;
			const parsed = BrowserSettingsCommandRequestSchema.safeParse(
				request.body,
			);
			if (!parsed.success)
				return browserFail(request, reply, 400, "browser.settings.invalid");
			try {
				return reply.send(await options.settings.command(parsed.data));
			} catch (error) {
				return settingsFailure(request, reply, error);
			}
		},
	);
}
