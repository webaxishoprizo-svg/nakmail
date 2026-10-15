// Admin API for the cold-mail engine. Every route requires an admin session.
import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin } from "../access/authz";
import { adminAccounts, primaryMailbox } from "../config";
import { timezoneOf } from "../iris/facts";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";
import { listAccountAddresses } from "../zoho/client";
import { isZohoConnected } from "../zoho/store";
import { checkSendingDomain, cloudflareDoh, type Doh } from "./dns";
import type { AutomationApi } from "./engine";
import { dayKey, isSenderBlocked, mapLeadTable, parseCsv, wordCount, lintEmail } from "./rules";
import { writeEmail, buildFooter, type WriterDeps } from "./writer";
import { automationStore, writerDeps } from "./wiring";
import { fetchSheetCsv } from "./sheets";

export { sheetCsvUrl } from "./sheets";

export const automation = new Hono<MailboxContext>();
automation.use("/api/v1/automation/*", requireAdmin);

const MAX_CSV = 1_500_000;
const extraBlocked = (env: Env) => String((env as any).COLD_BLOCKED_SENDERS ?? "").split(",");
const blockedReason = (env: Env, alias: string) => isSenderBlocked(alias, adminAccounts(env).map((a) => a.mailbox), extraBlocked(env));

// ---------- helpers ----------
const CampaignBody = z.object({
	name: z.string().min(1).max(100), sender_alias: z.string().email(), sender_name: z.string().min(1).max(100),
	company: z.string().max(150).optional(), postal_address: z.string().max(300).optional(), brief: z.string().min(1).max(3000),
	language: z.string().max(40).optional(), mode: z.enum(["draft_only", "auto_send"]).optional(),
	daily_cap: z.number().optional(), min_gap_min: z.number().optional(), max_gap_min: z.number().optional(),
	window_start: z.number().optional(), window_end: z.number().optional(), tz: z.string().max(60).optional(),
	days: z.array(z.number().int()).max(7).optional(), max_followups: z.number().optional(), followup_gap_days: z.number().optional(),
	allow_links: z.boolean().optional(),
});

async function guard<T>(c: any, fn: () => Promise<T>) {
	try { return await fn(); }
	catch (e) { return c.json({ error: (e as Error).message }, 400); }
}

// ---------- readiness: every condition that must hold before a campaign may start ----------
export interface ReadinessHooks { doh: Doh; addresses(env: Env): Promise<string[]> }
const realHooks: ReadinessHooks = {
	doh: cloudflareDoh,
	addresses: (env) => listAccountAddresses(env, primaryMailbox(env), String(env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase())),
};

export async function readiness(env: Env, store: AutomationApi, campaignId: string, hooks: ReadinessHooks = realHooks) {
	const c = await store.getCampaign(campaignId);
	if (!c) throw new Error("Campaign not found");
	const errors: string[] = [], warnings: string[] = [];

	const blocked = blockedReason(env, c.sender_alias);
	if (blocked) errors.push(blocked);
	if (!c.sender_name.trim()) errors.push("Add the sender name (a real person)");
	if (!c.company.trim()) errors.push("Add your company name");
	if (!c.postal_address.trim()) errors.push("Add a postal address (required in cold email law, shown in every email)");
	if (c.brief.trim().length < 30) errors.push("Describe what you offer in the brief (at least a couple of sentences)");
	if (!c.confirmed_legit) errors.push("Confirm that these are business contacts you may legitimately email and that you will honour opt-outs");

	const stats = await store.campaignStats(c, Date.now());
	if ((stats.leadCounts.new ?? 0) + (stats.leadCounts.contacted ?? 0) === 0) errors.push("Import leads first");

	if (!(await isZohoConnected(env, primaryMailbox(env)))) errors.push("Connect the primary Zoho account first (sign in as the primary admin)");
	else {
		try {
			if (!(await hooks.addresses(env)).includes(c.sender_alias)) errors.push(`${c.sender_alias} is not an alias on your Zoho account`);
		} catch (e) { errors.push(`Could not verify the alias with Zoho: ${(e as Error).message}`); }
	}

	const domain = c.sender_alias.split("@")[1];
	const health = await checkSendingDomain(domain, hooks.doh, (env as any).DKIM_SELECTOR || undefined);
	errors.push(...health.errors);
	warnings.push(...health.warnings);

	if (c.mode === "auto_send" && !(c.permission_until && c.permission_until > Date.now())) warnings.push("Auto-send is selected but permission is not granted: nothing will be sent until you grant it.");
	if (c.daily_cap > 20) warnings.push("A new sending alias is limited by the warm-up ramp (5/day at first), whatever the daily cap says.");
	return { ok: errors.length === 0, errors, warnings, domain: health };
}

// ---------- overview / master switch ----------
automation.get("/api/v1/automation/overview", (c) => guard(c, async () => {
	const store = automationStore(c.env);
	const now = Date.now();
	return c.json({
		settings: await store.getSettings(), campaigns: await store.listCampaigns(now), suppression: await store.suppressionCount(),
		sentToday: await store.sentTodayAll(dayKey(now, timezoneOf(c.env))), writer: String((c.env as any).WRITER_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
	});
}));

automation.post("/api/v1/automation/master", (c) => guard(c, async () => {
	const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
	return c.json(await automationStore(c.env).setMaster(body.enabled, c.get("session")!.email, Date.now()));
}));

// ---------- campaigns ----------
automation.post("/api/v1/automation/campaigns", (c) => guard(c, async () => {
	const body = CampaignBody.parse(await c.req.json());
	const blocked = blockedReason(c.env, body.sender_alias);
	if (blocked) return c.json({ error: blocked }, 400);
	const id = await automationStore(c.env).createCampaign({ tz: timezoneOf(c.env), ...body }, c.get("session")!.email, Date.now());
	return c.json({ id }, 201);
}));

automation.patch("/api/v1/automation/campaigns/:id", (c) => guard(c, async () => {
	const body = CampaignBody.partial().parse(await c.req.json());
	if (body.sender_alias) { const b = blockedReason(c.env, body.sender_alias); if (b) return c.json({ error: b }, 400); }
	return c.json(await automationStore(c.env).updateCampaign(c.req.param("id"), body));
}));

automation.get("/api/v1/automation/campaigns/:id", (c) => guard(c, async () => {
	const store = automationStore(c.env);
	const campaign = await store.getCampaign(c.req.param("id"));
	if (!campaign) return c.json({ error: "Campaign not found" }, 404);
	return c.json({ campaign, stats: await store.campaignStats(campaign, Date.now()), sender: await store.senderInfo(campaign.sender_alias, Date.now(), campaign.tz), events: await store.events(campaign.id, 40) });
}));

automation.get("/api/v1/automation/campaigns/:id/readiness", (c) => guard(c, async () => c.json(await readiness(c.env, automationStore(c.env), c.req.param("id")))));

automation.post("/api/v1/automation/campaigns/:id/confirm-legit", (c) => guard(c, async () => {
	await automationStore(c.env).confirmLegit(c.req.param("id"), c.get("session")!.email);
	return c.json({ ok: true });
}));

automation.post("/api/v1/automation/campaigns/:id/activate", (c) => guard(c, async () => {
	const store = automationStore(c.env);
	const r = await readiness(c.env, store, c.req.param("id"));
	if (!r.ok) return c.json({ error: "Not ready to start", errors: r.errors, warnings: r.warnings }, 409);
	return c.json(await store.setStatus(c.req.param("id"), "active", null, c.get("session")!.email, Date.now()));
}));
automation.post("/api/v1/automation/campaigns/:id/pause", (c) => guard(c, async () =>
	c.json(await automationStore(c.env).setStatus(c.req.param("id"), "paused", "paused by admin", c.get("session")!.email, Date.now()))));
automation.post("/api/v1/automation/campaigns/:id/stop", (c) => guard(c, async () =>
	c.json(await automationStore(c.env).setStatus(c.req.param("id"), "stopped", "stopped by admin", c.get("session")!.email, Date.now()))));

automation.post("/api/v1/automation/campaigns/:id/permission", (c) => guard(c, async () => {
	const body = z.object({ hours: z.number().min(1).max(720) }).parse(await c.req.json());
	const store = automationStore(c.env);
	const camp = await store.getCampaign(c.req.param("id"));
	if (!camp) return c.json({ error: "Campaign not found" }, 404);
	if (camp.mode !== "auto_send") return c.json({ error: "Switch the campaign to auto-send mode first" }, 400);
	if (!camp.confirmed_legit) return c.json({ error: "Confirm the contacts are legitimate before granting auto-send" }, 400);
	return c.json(await store.grantPermission(camp.id, body.hours, c.get("session")!.email, Date.now()));
}));
automation.delete("/api/v1/automation/campaigns/:id/permission", (c) => guard(c, async () =>
	c.json(await automationStore(c.env).revokePermission(c.req.param("id"), c.get("session")!.email, Date.now()))));

// ---------- leads / sheet ----------
automation.post("/api/v1/automation/campaigns/:id/import", (c) => guard(c, async () => {
	const body = z.object({ csv: z.string().max(MAX_CSV).optional(), sheetUrl: z.string().max(500).optional() }).parse(await c.req.json());
	const csv = body.csv ?? (body.sheetUrl ? await fetchSheetCsv(body.sheetUrl) : "");
	if (!csv.trim()) return c.json({ error: "Provide a CSV file or a Google Sheets link" }, 400);
	const mapped = mapLeadTable(parseCsv(csv));
	if (mapped.error) return c.json({ error: mapped.error }, 400);
	return c.json(await automationStore(c.env).importLeads(c.req.param("id"), mapped.leads, Date.now()));
}));

automation.get("/api/v1/automation/campaigns/:id/leads", (c) => guard(c, async () =>
	c.json(await automationStore(c.env).listLeads(c.req.param("id"), c.req.query("status") || undefined, Number(c.req.query("page") ?? 1), 50))));
automation.get("/api/v1/automation/campaigns/:id/analysis", (c) => guard(c, async () => c.json(await automationStore(c.env).analyzeLeads(c.req.param("id")))));
automation.get("/api/v1/automation/campaigns/:id/events", (c) => guard(c, async () => c.json(await automationStore(c.env).events(c.req.param("id"), 100))));

/** Dry run: write up to 3 emails exactly as the engine would, without saving or sending anything. */
export async function previewDrafts(store: AutomationApi, writer: WriterDeps, campaignId: string, count: number) {
	const campaign = await store.getCampaign(campaignId);
	if (!campaign) throw new Error("Campaign not found");
	const leads = await store.sampleLeads(campaignId, count);
	const recent = await store.recentMessages(campaignId, 40);
	const out: { to: string; subject?: string; text?: string; words?: number; problems?: string[] }[] = [];
	for (const lead of leads) {
		const d = await writeEmail({ campaign, lead, recent, previous: [] }, writer);
		if ("error" in d) { out.push({ to: lead.email, problems: [d.error] }); continue; }
		recent.unshift({ subject: d.subject, body: d.body, style: JSON.stringify(d.style) });
		out.push({ to: lead.email, subject: d.subject, text: `${d.body}\n\n${buildFooter(campaign, lead.id)}`, words: wordCount(d.body), problems: lintEmail({ subject: d.subject, body: d.body, step: 0, allowLinks: !!campaign.allow_links }) });
	}
	return out;
}
automation.post("/api/v1/automation/campaigns/:id/preview", (c) => guard(c, async () => {
	const body = z.object({ count: z.number().int().min(1).max(3).optional() }).parse(await c.req.json().catch(() => ({})));
	return c.json({ previews: await previewDrafts(automationStore(c.env), writerDeps(c.env), c.req.param("id"), body.count ?? 3) });
}));

// ---------- approvals ----------
automation.get("/api/v1/automation/approvals", (c) => guard(c, async () => c.json(await automationStore(c.env).pendingApprovals(c.req.query("campaignId") || undefined))));
automation.post("/api/v1/automation/messages/:id/approve", (c) => guard(c, async () => {
	const edits = z.object({ subject: z.string().max(120).optional(), body: z.string().max(3000).optional() }).parse(await c.req.json().catch(() => ({})));
	await automationStore(c.env).approveMessage(c.req.param("id"), edits, c.get("session")!.email, Date.now());
	return c.json({ ok: true });
}));
automation.post("/api/v1/automation/messages/:id/reject", (c) => guard(c, async () => {
	await automationStore(c.env).rejectMessage(c.req.param("id"), c.get("session")!.email, Date.now());
	return c.json({ ok: true });
}));
automation.post("/api/v1/automation/leads/:id/skip", (c) => guard(c, async () => {
	await automationStore(c.env).skipLead(c.req.param("id"), c.get("session")!.email, Date.now());
	return c.json({ ok: true });
}));

// ---------- suppression / senders / health ----------
automation.post("/api/v1/automation/suppression", (c) => guard(c, async () => {
	const body = z.object({ email: z.string().email() }).parse(await c.req.json());
	await automationStore(c.env).addSuppression(body.email, "added by admin", Date.now());
	return c.json({ ok: true });
}));

automation.get("/api/v1/automation/senders", (c) => guard(c, async () => {
	const store = automationStore(c.env);
	let addresses: string[] = [];
	let error: string | undefined;
	try { addresses = await realHooks.addresses(c.env); } catch (e) { error = (e as Error).message; }
	const tz = timezoneOf(c.env);
	const eligible = addresses.filter((a) => !blockedReason(c.env, a));
	const senders = await Promise.all(eligible.map((a) => store.senderInfo(a, Date.now(), tz)));
	return c.json({ senders, error });
}));

automation.get("/api/v1/automation/health", (c) => guard(c, async () => {
	const domain = primaryMailbox(c.env).split("@")[1];
	return c.json({ domain: await checkSendingDomain(domain, cloudflareDoh, (c.env as any).DKIM_SELECTOR || undefined), zohoConnected: await isZohoConnected(c.env, primaryMailbox(c.env)) });
}));
