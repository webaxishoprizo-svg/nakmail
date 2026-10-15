// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

const legacyRoute = (path: string) => route(path, "routes/legacy-mailbox-redirect.tsx", {
	id: `legacy-${path.replaceAll("/", "-").replaceAll(":", "")}`,
});

export default [
	index("routes/home.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder", "routes/email-list.tsx"),
		route("drafts", "routes/drafts.tsx"),
		route("priority", "routes/priority.tsx"),
		route("starred", "routes/starred.tsx"),
		route("leads", "routes/leads.tsx"),
		route("follow-ups", "routes/follow-ups.tsx"),
		route("opportunities", "routes/opportunities.tsx"),
		route("projects", "routes/projects.tsx"),
		route("clients", "routes/clients.tsx"),
		route("finance", "routes/finance.tsx"),
		route("internal", "routes/internal.tsx"),
		route("analytics", "routes/analytics.tsx"),
		route("assistant", "routes/assistant.tsx"),
		route("api-access", "routes/api-access.tsx"),
		route("settings", "routes/settings.tsx"),
		route("automation", "routes/automation.tsx"),
		route("automations", "routes/automations.tsx"),
		route("search", "routes/search-results.tsx"),
	]),
	// Keep the URLs used by the previous app working. Each path is redirected
	// into the signed-in user's first Zoho mailbox.
	legacyRoute("mailbox"),
	legacyRoute("inbox"),
	legacyRoute("priority"),
	legacyRoute("starred"),
	legacyRoute("drafts"),
	legacyRoute("sent"),
	legacyRoute("compose"),
	legacyRoute("search"),
	legacyRoute("leads"),
	legacyRoute("follow-ups"),
	legacyRoute("opportunities"),
	legacyRoute("projects"),
	legacyRoute("clients"),
	legacyRoute("finance"),
	legacyRoute("internal"),
	legacyRoute("analytics"),
	legacyRoute("assistant"),
	legacyRoute("api-access"),
	legacyRoute("settings"),
	legacyRoute("automations"),
	legacyRoute("email/:emailId"),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
