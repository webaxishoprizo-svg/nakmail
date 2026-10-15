// Authorization middleware. Fails closed: no session -> 401, wrong role/mailbox -> 403.
import { createMiddleware } from "hono/factory";
import type { MailboxContext } from "../lib/mailbox";
import { hasAlias } from "./store";
import { canAdminOpen } from "./visibility";
import { adminForGoogle } from "../config";

export const requireAdmin = createMiddleware<MailboxContext>(async (c, next) => {
	const s = c.get("session");
	if (!s) return c.json({ error: "Unauthorized" }, 401);
	if (s.role !== "admin" || !adminForGoogle(c.env, s.email)) return c.json({ error: "Forbidden" }, 403);
	await next();
});

/** Admin: own mailbox + alias mailboxes. User: only the aliases assigned to their Google account. */
export const mailboxAuthz = createMiddleware<MailboxContext>(async (c, next) => {
	const s = c.get("session");
	if (!s) return c.json({ error: "Unauthorized" }, 401);
	const raw = c.req.param("mailboxId");
	if (!raw) return c.json({ error: "Mailbox ID required" }, 400);
	const id = raw.trim().toLowerCase(); // Hono has already percent-decoded the path param
	if (s.role === "admin") {
		return canAdminOpen(c.env, s, id) ? next() : c.json({ error: "Forbidden" }, 403);
	}
	if (await hasAlias(c.env, s.email, id)) return next();
	return c.json({ error: "Forbidden" }, 403);
});
