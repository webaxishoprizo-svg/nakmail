// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createRequestHandler } from "react-router";
import { app as apiApp } from "./index";
import { access } from "./access/routes";
import { automation } from "./automation/routes";
import { automationTick } from "./automation/wiring";
import { iris } from "./iris/routes";
import { adminAccounts } from "./config";
import { auth } from "./auth";
import { readSession, SESSION_COOKIE, type Session } from "./auth/session";
import { syncZoho } from "./zoho/sync";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { ConfigDO } from "./durableObject/config";
export { AutomationDO } from "./automation/do";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: { session: Session } }>();

// Session middleware: everything except /auth/* requires a logged-in Google session.
app.use("*", async (c, next) => {
	const path = new URL(c.req.url).pathname;
	if (path.startsWith("/auth/")) return next();

	const authorization = c.req.header("Authorization") ?? "";
	if (authorization.startsWith("Bearer nak_live.")) {
		const match = authorization.slice("Bearer ".length).match(/^nak_live\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/i);
		const mailboxMatch = path.match(/^\/api\/v1\/mailboxes\/([^/]+)\/(.*)$/);
		if (!match || !mailboxMatch) return c.json({ error: "Invalid API token or unsupported endpoint" }, 401);
		const [, rawMailboxId, endpoint] = mailboxMatch;
		let mailboxId: string;
		try { mailboxId = decodeURIComponent(rawMailboxId).toLowerCase(); } catch { return c.json({ error: "Invalid mailbox" }, 400); }
		const method = c.req.method.toUpperCase();
		const requiredScope = method === "GET" || method === "HEAD"
			? (/^(emails(?:\/[^/]+(?:\/attachments\/[^/]+)?)?|threads\/[^/]+|search|folders|stats|shared-drafts)$/.test(endpoint) ? "mail:read" : null)
			: method === "POST" && (endpoint === "drafts" || endpoint === "shared-drafts") ? "mail:draft"
			: method === "POST" && (/^emails$/.test(endpoint) || /^emails\/[^/]+\/(reply|forward)$/.test(endpoint)) ? "mail:send"
			: null;
		if (!requiredScope) return c.json({ error: "This API key cannot access that endpoint" }, 403);
		const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const keySession = await (stub as any).verifyAPIKey(match[1], match[2], requiredScope);
		if (!keySession) return c.json({ error: "Invalid, expired, revoked, or insufficiently scoped API key" }, 401);
		c.set("session", keySession);
		return next();
	}

	if (import.meta.env.DEV) { // local development only
		c.set("session", { email: adminAccounts(c.env)[0]?.google ?? "dev@localhost", role: "admin" });
		return next();
	}

	const session = await readSession(c.env, getCookie(c, SESSION_COOKIE));
	if (!session) {
		const isApi = path.startsWith("/api/") || path.startsWith("/agents") || path.startsWith("/mcp");
		return isApi ? c.json({ error: "Unauthorized" }, 401) : c.redirect("/auth/login");
	}
	c.set("session", session); // used by the API for per-mailbox authorization
	return next();
});

app.route("/", auth);
app.route("/", access);
app.route("/", iris);
app.route("/", automation);

// AI agent and MCP endpoints are disabled in the Zoho setup.
app.all("/mcp", (c) => c.text("Not found", 404));
app.all("/mcp/*", (c) => c.text("Not found", 404));

// Mount the API routes
app.route("/", apiApp);

app.all("/agents/*", (c) => c.text("Not found", 404));

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		// "* * * * *" = automation engine tick (every minute); "*/2 * * * *" = Zoho mail sync.
		if (event.cron === "* * * * *") ctx.waitUntil(automationTick(env));
		else ctx.waitUntil(syncZoho(env).catch((e) => console.error("Scheduled Zoho sync failed:", (e as Error).message)));
	},
};
