// One engine tick: look at the inbox, pick at most ONE job, and do it. Every send passes the kill-switch checkpoint.
import { buildFooter, footerIsComplete, type Draft } from "./writer";
import { classifyInbound, type InboundRow } from "./rules";
import type { AutomationStore, Campaign, Job, Lead } from "./store";

export type Remote<T> = { [K in keyof T as T[K] extends (...a: any) => any ? K : never]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never };
export type AutomationApi = Remote<AutomationStore>;

export interface EngineDeps {
	now(): number;
	store: AutomationApi;
	write(job: Extract<Job, { kind: "generate" }>): Promise<Draft | { error: string }>;
	send(m: { from: string; to: string; subject: string; text: string }): Promise<void>;
	mxOk(domain: string): Promise<boolean>;
	inbound(sinceMs: number): Promise<InboundRow[]>;
	syncFresh(): Promise<boolean>;
}
export interface TickResult { action: string; detail?: string }

const MIN = 60_000;

/** Reply / bounce / opt-out detection. Runs before every job so a reply stops the sequence immediately. */
async function processInbox(d: EngineDeps, now: number): Promise<void> {
	const tracked = await d.store.trackedLeads(now);
	if (tracked.length === 0) return;
	const cursor = await d.store.getInboxCursor();
	const oldest = Math.min(...tracked.map((t) => t.last_sent_at));
	const since = cursor > 0 ? Math.max(oldest, cursor - 10 * MIN) : oldest; // 10-minute overlap covers sync delay
	const events = classifyInbound(await d.inbound(since), tracked);
	if (events.length) await d.store.applyInbound(events, now);
	await d.store.setInboxCursor(now);
}

async function deliver(d: EngineDeps, campaign: Campaign, lead: Lead, messageId: string, subject: string, body: string): Promise<TickResult> {
	// Kill-switch checkpoint: re-check everything right before the real send.
	const chk = await d.store.canSend(messageId, d.now());
	if (!chk.ok) {
		// Something changed since the claim. An auto-approved draft is discarded (a fresh one is written later);
		// a draft a human approved stays approved and is sent when allowed again.
		if (campaign.mode === "auto_send") await d.store.cancelAutoDrafts(campaign.id, d.now());
		else await d.store.unlockLead(lead.id);
		return { action: "blocked", detail: chk.reason };
	}
	if (lead.step > 0 && !(await d.syncFresh())) { await d.store.unlockLead(lead.id); return { action: "deferred", detail: "inbox sync is stale" }; }
	const text = `${body}\n\n${buildFooter(campaign, lead.id)}`;
	if (!footerIsComplete(text, campaign)) {
		// Never send an email without sender identity, postal address and opt-out.
		await d.store.cancelAutoDrafts(campaign.id, d.now());
		await d.store.setStatus(campaign.id, "paused", "Email footer incomplete: add a postal address and sender name", "engine", d.now());
		return { action: "blocked", detail: "footer incomplete" };
	}
	if (!(await d.store.beginSend(messageId))) return { action: "blocked", detail: "message already handled" };
	try {
		await d.send({ from: campaign.sender_alias, to: lead.email, subject, text });
	} catch (e) {
		await d.store.markFailed(messageId, (e as Error).message, d.now());
		return { action: "send_failed", detail: (e as Error).message };
	}
	await d.store.markSent(messageId, d.now());
	return { action: "sent", detail: lead.email };
}

export async function runTick(d: EngineDeps): Promise<TickResult> {
	const now = d.now();
	if (!(await d.store.getSettings()).masterEnabled) return { action: "off" };
	await processInbox(d, now);

	const job = await d.store.claimNext(now);
	if (!job) return { action: "idle" };

	if (job.kind === "send") return deliver(d, job.campaign, job.lead, job.message.id, job.message.subject, job.message.body);

	const { lead, campaign } = job;
	if (lead.step > 0 && !(await d.syncFresh())) {
		await d.store.releaseLead(lead.id, now + 5 * MIN, "inbox sync is stale", now, false);
		return { action: "deferred", detail: "inbox sync is stale" };
	}
	if (!(await d.mxOk(lead.email.split("@")[1]))) {
		await d.store.setLeadStatus(lead.id, "invalid", "domain cannot receive mail", now);
		return { action: "invalid", detail: lead.email };
	}
	const draft = await d.write(job);
	if ("error" in draft) {
		await d.store.releaseLead(lead.id, now + 30 * MIN, `writer: ${draft.error}`, now, true);
		return { action: "writer_failed", detail: draft.error };
	}
	const saved = await d.store.saveDraft(lead.id, draft, d.now());
	if (saved.status === "pending_approval") return { action: "drafted", detail: lead.email };
	return deliver(d, campaign, lead, saved.messageId, draft.subject, draft.body);
}
