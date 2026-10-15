// Admin endpoints (assign Google accounts to aliases), /api/v1/me, and Zoho status/sync.
import { Hono } from "hono";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { getMailboxStub } from "../lib/email-helpers";
import { adminForGoogle, isAdminMailbox, primaryMailbox } from "../config";
import { listAccountAddresses, ZohoError } from "../zoho/client";
import { isZohoConnected } from "../zoho/store";
import { backfillAlias, ensureMailbox, syncZoho } from "../zoho/sync";
import { loadCustomers, saveCustomers } from "../lib/customers";
import { requireAdmin } from "./authz";
import { AccessError, addAssignment, allowedDomains, listAssignments, normalize, removeAssignment } from "./store";

export const access = new Hono<MailboxContext>();

const Body = z.object({ email: z.string(), alias: z.string() });

access.get("/api/v1/me", (c) => {
	const s = c.get("session");
	if (!s) return c.json({ error: "Unauthorized" }, 401);
	return c.json({ email: s.email, role: s.role, mailbox: adminForGoogle(c.env, s.email)?.mailbox ?? null });
});

access.use("/api/v1/admin/*", requireAdmin);
access.use("/api/v1/zoho/*", requireAdmin);

access.get("/api/v1/admin/assignments", async (c) => {
	const assignments = await listAssignments(c.env);
	let suggestions: string[] = [];
	try {
		suggestions = (await listAccountAddresses(c.env, primaryMailbox(c.env), allowedDomains(c.env)))
			.filter((a) => !isAdminMailbox(c.env, a));
	} catch {
		// Zoho not connected yet or temporarily unavailable: suggestions are optional.
	}
	return c.json({ assignments, suggestions, mainMailbox: primaryMailbox(c.env) });
});

access.post("/api/v1/admin/assignments", async (c) => {
	const parsed = Body.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "email and alias are required" }, 400);
	try {
		const created = await addAssignment(c.env, parsed.data);
		const alias = await ensureMailbox(c.env, normalize(parsed.data.alias));
		await getMailboxStub(c.env, alias).getFolders(); // make sure the alias mailbox exists
		c.executionCtx.waitUntil(
			backfillAlias(c.env, alias).catch((e) => console.error("Alias backfill failed:", (e as Error).message)),
		);
		return c.json({ email: normalize(parsed.data.email), alias, created }, created ? 201 : 200);
	} catch (e) {
		if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 400);
		throw e;
	}
});

access.get("/api/v1/admin/customers", async (c) => {
	const cu = await loadCustomers(c.env);
	return c.json({ emails: [...cu.emails], domains: [...cu.domains] });
});

access.put("/api/v1/admin/customers", async (c) => {
	const body = (await c.req.json().catch(() => null)) as { emails?: unknown; domains?: unknown } | null;
	if (!body) return c.json({ error: "Invalid body" }, 400);
	return c.json(await saveCustomers(c.env, body));
});

access.delete("/api/v1/admin/assignments", async (c) => {
	const email = c.req.query("email");
	const alias = c.req.query("alias");
	if (!email || !alias) return c.json({ error: "email and alias are required" }, 400);
	const removed = await removeAssignment(c.env, { email, alias });
	return removed ? c.body(null, 204) : c.json({ error: "Assignment not found" }, 404);
});

// Status / manual sync apply to the signed-in admin's OWN Zoho account.
const ownAccount = (c: any): string | undefined => adminForGoogle(c.env, c.get("session")?.email ?? "")?.mailbox;

access.get("/api/v1/zoho/status", async (c) => {
	const mailbox = ownAccount(c);
	if (!mailbox) return c.json({ error: "Forbidden" }, 403);
	return c.json({ connected: await isZohoConnected(c.env, mailbox), mailbox });
});

access.post("/api/v1/zoho/sync", async (c) => {
	const mailbox = ownAccount(c);
	if (!mailbox) return c.json({ error: "Forbidden" }, 403);
	if (!(await isZohoConnected(c.env, mailbox))) {
		return c.json({ error: `Zoho is not connected for ${mailbox}. Connect it from the admin account settings first.` }, 409);
	}
	try {
		return c.json(await syncZoho(c.env, mailbox));
	} catch (e) {
		return c.json({ error: (e as Error).message }, e instanceof ZohoError ? (e.status as 502) : 500);
	}
});
