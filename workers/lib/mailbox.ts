// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in the app config store, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Session } from "../auth/session";
import type { Env } from "../types";
import { configStore } from "./config-store";
import { getMailboxStub } from "./email-helpers";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		session: Session;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await configStore(c.env).hasValue(key))) {
		return c.json({ error: "Not found" }, 404);
	}

	// Instantiate DO stub
	const stub = getMailboxStub(c.env, mailboxId);

	c.set("mailboxStub", stub);
	
	await next();
});
