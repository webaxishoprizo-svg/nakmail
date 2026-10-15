// Cold-mail engine state (campaigns, leads, drafts, send log, suppression) in SQLite.
// Runs inside the AutomationDO, but only needs an `exec` function so it is also unit-tested on node:sqlite.
import {
	ABSOLUTE_MAX_PER_ALIAS_DAY, DAY_MS, MAX_FOLLOWUPS, MAX_LEADS_PER_CAMPAIGN, MAX_PENDING_APPROVALS, MAX_PER_DOMAIN_PER_DAY,
	RECENT_CONTACT_DAYS, dayKey, daysBetweenKeys, effectiveDailyCap, followupDelayMs, inSendWindow, lintEmail, randomGapMs, validateLeadEmail,
	type InboundEvent, type LeadInput, type Style,
} from "./rules";

export interface Sql { exec(query: string, ...bindings: any[]): Iterable<Record<string, unknown>> }
export interface Policy { isSenderBlocked(alias: string): string | null }

export type CampaignStatus = "draft" | "active" | "paused" | "stopped";
export type Mode = "draft_only" | "auto_send";

export interface Campaign {
	id: string; name: string; status: CampaignStatus; mode: Mode; sender_alias: string; sender_name: string; company: string;
	postal_address: string; brief: string; language: string; daily_cap: number; min_gap_min: number; max_gap_min: number;
	window_start: number; window_end: number; tz: string; days: string; max_followups: number; followup_gap_days: number;
	allow_links: number; permission_until: number | null; permission_by: string | null; confirmed_legit: number;
	created_by: string | null; created_at: number; paused_reason: string | null;
}
export interface Lead {
	id: string; campaign_id: string; email: string; name: string | null; company: string | null; role: string | null;
	website: string | null; notes: string | null; extra: string | null; status: string; step: number; next_send_at: number;
	last_sent_at: number | null; lock_until: number; fail_count: number; created_at: number;
}
export interface Message {
	id: string; lead_id: string; campaign_id: string; step: number; subject: string; body: string; style: string | null;
	status: string; created_at: number; sent_at: number | null; sent_day: string | null; to_email: string; from_alias: string; error: string | null;
}
export type Job =
	| { kind: "generate"; campaign: Campaign; lead: Lead; recent: { subject: string; body: string; style: string | null }[]; previous: { subject: string; body: string; step: number }[] }
	| { kind: "send"; campaign: Campaign; lead: Lead; message: Message };

export interface CampaignInput {
	name: string; sender_alias: string; sender_name: string; company?: string; postal_address?: string; brief: string; language?: string;
	mode?: Mode; daily_cap?: number; min_gap_min?: number; max_gap_min?: number; window_start?: number; window_end?: number;
	tz?: string; days?: number[]; max_followups?: number; followup_gap_days?: number; allow_links?: boolean;
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
	const v = Number(n);
	return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
};
const validTz = (tz: unknown, dflt: string): string => {
	try { if (typeof tz === "string" && tz) { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } } catch { /* fall through */ }
	return dflt;
};
const uid = () => crypto.randomUUID();
const TERMINAL = new Set(["replied", "bounced", "unsubscribed", "completed", "invalid", "skipped"]);

export class AutomationStore {
	constructor(private sql: Sql, private policy: Policy, private rng: () => number = Math.random) {
		this.sql.exec(SCHEMA);
	}

	private q<T = any>(query: string, ...b: unknown[]): T[] { return [...this.sql.exec(query, ...b)] as T[]; }
	private one<T = any>(query: string, ...b: unknown[]): T | undefined { return this.q<T>(query, ...b)[0]; }
	private run(query: string, ...b: unknown[]): void { void [...this.sql.exec(query, ...b)]; }
	private log(type: string, campaignId: string | null, leadId: string | null, detail: string, now = Date.now()): void {
		this.run("INSERT INTO events (ts, type, campaign_id, lead_id, detail) VALUES (?, ?, ?, ?, ?)", now, type, campaignId, leadId, detail.slice(0, 500));
	}

	// ---------- settings ----------
	private getSetting(key: string, dflt: string): string { return this.one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? dflt; }
	private setSetting(key: string, value: string): void { this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value); }

	getSettings() {
		return {
			masterEnabled: this.getSetting("master_enabled", "0") === "1",
			changedBy: this.getSetting("master_by", ""), changedAt: Number(this.getSetting("master_at", "0")),
			globalDailyCap: Number(this.getSetting("global_cap", "150")),
		};
	}
	setMaster(enabled: boolean, by: string, now = Date.now()) {
		this.setSetting("master_enabled", enabled ? "1" : "0"); this.setSetting("master_by", by); this.setSetting("master_at", String(now));
		this.setSetting("consecutive_failures", "0");
		if (!enabled) this.cancelAutoDrafts(null, now);
		this.log(enabled ? "master_on" : "master_off", null, null, `by ${by}`, now);
		return this.getSettings();
	}
	setGlobalCap(cap: number) { this.setSetting("global_cap", String(clamp(cap, 1, 500, 150))); return this.getSettings(); }

	// ---------- campaigns ----------
	createCampaign(i: CampaignInput, by: string, now = Date.now()): string {
		const id = uid();
		const start = clamp(i.window_start, 0, 23, 10);
		const minGap = clamp(i.min_gap_min, 4, 240, 8);
		const days = (i.days?.length ? i.days : [1, 2, 3, 4, 5]).filter((d) => d >= 1 && d <= 7);
		this.run(
			`INSERT INTO campaigns (id, name, status, mode, sender_alias, sender_name, company, postal_address, brief, language, daily_cap, min_gap_min, max_gap_min,
				window_start, window_end, tz, days, max_followups, followup_gap_days, allow_links, created_by, created_at)
			 VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, String(i.name).trim().slice(0, 100), i.mode === "auto_send" ? "auto_send" : "draft_only", String(i.sender_alias).trim().toLowerCase(),
			String(i.sender_name).trim().slice(0, 100), String(i.company ?? "").trim().slice(0, 150), String(i.postal_address ?? "").trim().slice(0, 300),
			String(i.brief).trim().slice(0, 3000), String(i.language ?? "English").slice(0, 40),
			clamp(i.daily_cap, 1, ABSOLUTE_MAX_PER_ALIAS_DAY, 20), minGap, clamp(i.max_gap_min, minGap, 480, Math.max(minGap, 20)),
			start, clamp(i.window_end, start + 1, 24, Math.max(start + 1, 17)), validTz(i.tz, "Asia/Kolkata"),
			(days.length ? days : [1, 2, 3, 4, 5]).join(","), clamp(i.max_followups, 0, MAX_FOLLOWUPS, 2), clamp(i.followup_gap_days, 2, 30, 4), i.allow_links ? 1 : 0, by, now,
		);
		this.log("campaign_created", id, null, `by ${by}`, now);
		return id;
	}

	updateCampaign(id: string, p: Partial<CampaignInput>): Campaign {
		const c = this.getCampaign(id);
		if (!c) throw new Error("Campaign not found");
		if (c.status === "active") throw new Error("Pause the campaign before editing it");
		const next = { ...c, ...p } as any;
		const days = Array.isArray(p.days) ? p.days.filter((d) => d >= 1 && d <= 7).join(",") : c.days;
		const start = clamp(next.window_start, 0, 23, c.window_start);
		const minGap = clamp(next.min_gap_min, 4, 240, c.min_gap_min);
		this.run(
			`UPDATE campaigns SET name=?, mode=?, sender_alias=?, sender_name=?, company=?, postal_address=?, brief=?, language=?, daily_cap=?, min_gap_min=?, max_gap_min=?,
			 window_start=?, window_end=?, tz=?, days=?, max_followups=?, followup_gap_days=?, allow_links=? WHERE id=?`,
			String(next.name).trim().slice(0, 100), next.mode === "auto_send" ? "auto_send" : "draft_only", String(next.sender_alias).trim().toLowerCase(),
			String(next.sender_name).trim().slice(0, 100), String(next.company ?? "").trim().slice(0, 150), String(next.postal_address ?? "").trim().slice(0, 300),
			String(next.brief).trim().slice(0, 3000), String(next.language ?? "English").slice(0, 40), clamp(next.daily_cap, 1, ABSOLUTE_MAX_PER_ALIAS_DAY, c.daily_cap),
			minGap, clamp(next.max_gap_min, minGap, 480, Math.max(minGap, c.max_gap_min)), start, clamp(next.window_end, start + 1, 24, c.window_end),
			validTz(next.tz, c.tz), days || c.days, clamp(next.max_followups, 0, MAX_FOLLOWUPS, c.max_followups), clamp(next.followup_gap_days, 2, 30, c.followup_gap_days),
			next.allow_links ? 1 : 0, id,
		);
		if (p.mode === "draft_only") this.run("UPDATE campaigns SET permission_until = NULL, permission_by = NULL WHERE id = ?", id);
		return this.getCampaign(id)!;
	}

	getCampaign(id: string): Campaign | undefined { return this.one<Campaign>("SELECT * FROM campaigns WHERE id = ?", id); }

	confirmLegit(id: string, by: string, now = Date.now()) {
		this.run("UPDATE campaigns SET confirmed_legit = 1 WHERE id = ?", id);
		this.log("legit_confirmed", id, null, `by ${by}`, now);
	}

	listCampaigns(now = Date.now()) {
		return this.q<Campaign>("SELECT * FROM campaigns ORDER BY created_at DESC").map((c) => ({ ...c, ...this.campaignStats(c, now) }));
	}

	campaignStats(c: Campaign, now = Date.now()) {
		const leads = Object.fromEntries(this.q<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM leads WHERE campaign_id = ? GROUP BY status", c.id).map((r) => [r.status, r.n]));
		const sent = this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND status = 'sent'", c.id)?.n ?? 0;
		const today = dayKey(now, c.tz);
		return {
			leadCounts: leads as Record<string, number>,
			totalLeads: Object.values(leads).reduce((a: number, b) => a + (b as number), 0),
			sent, sentToday: this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND status = 'sent' AND sent_day = ?", c.id, today)?.n ?? 0,
			pendingApproval: this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND status = 'pending_approval'", c.id)?.n ?? 0,
			permissionActive: !!(c.permission_until && c.permission_until > now),
		};
	}

	setStatus(id: string, status: CampaignStatus, reason: string | null, by: string, now = Date.now()) {
		this.run("UPDATE campaigns SET status = ?, paused_reason = ? WHERE id = ?", status, reason, id);
		if (status !== "active") this.cancelAutoDrafts(id, now);
		if (status === "stopped") this.run("UPDATE messages SET status = 'cancelled' WHERE campaign_id = ? AND status IN ('pending_approval','approved')", id);
		this.log(`campaign_${status}`, id, null, `${by}${reason ? `: ${reason}` : ""}`, now);
		return this.getCampaign(id)!;
	}

	grantPermission(id: string, hours: number, by: string, now = Date.now()) {
		const h = clamp(hours, 1, 24 * 30, 24);
		this.run("UPDATE campaigns SET permission_until = ?, permission_by = ? WHERE id = ?", now + h * 3_600_000, by, id);
		this.log("permission_granted", id, null, `${h}h by ${by}`, now);
		return this.getCampaign(id)!;
	}
	revokePermission(id: string, by: string, now = Date.now()) {
		this.run("UPDATE campaigns SET permission_until = NULL, permission_by = NULL WHERE id = ?", id);
		this.cancelAutoDrafts(id, now);
		this.log("permission_revoked", id, null, `by ${by}`, now);
		return this.getCampaign(id)!;
	}

	// ---------- leads ----------
	isSuppressed(email: string): boolean { return !!this.one("SELECT 1 FROM suppression WHERE email = ?", email.toLowerCase()); }
	addSuppression(email: string, reason: string, now = Date.now()) {
		this.run("INSERT INTO suppression (email, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING", email.trim().toLowerCase(), reason, now);
	}
	suppressionCount(): number { return this.one<{ n: number }>("SELECT COUNT(*) n FROM suppression")?.n ?? 0; }

	importLeads(campaignId: string, leads: LeadInput[], now = Date.now()) {
		const c = this.getCampaign(campaignId);
		if (!c) throw new Error("Campaign not found");
		let total = this.one<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ?", campaignId)?.n ?? 0;
		const res = { added: 0, duplicates: 0, suppressed: 0, invalid: [] as { email: string; reason: string }[], capped: 0 };
		for (const l of leads) {
			const email = String(l.email ?? "").trim().toLowerCase();
			const bad = validateLeadEmail(email);
			if (bad) { res.invalid.push({ email, reason: bad }); continue; }
			if (this.isSuppressed(email)) { res.suppressed++; continue; }
			if (this.one("SELECT 1 FROM leads WHERE campaign_id = ? AND email = ?", campaignId, email)) { res.duplicates++; continue; }
			if (total >= MAX_LEADS_PER_CAMPAIGN) { res.capped++; continue; }
			this.run(
				`INSERT INTO leads (id, campaign_id, email, name, company, role, website, notes, extra, status, step, next_send_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, 0, ?)`,
				uid(), campaignId, email, l.name || null, l.company || null, l.role || null, l.website || null, l.notes || null,
				l.extra && Object.keys(l.extra).length ? JSON.stringify(l.extra) : null, now,
			);
			res.added++; total++;
		}
		this.log("leads_imported", campaignId, null, `added ${res.added}, dup ${res.duplicates}, invalid ${res.invalid.length}, suppressed ${res.suppressed}`, now);
		return res;
	}

	listLeads(campaignId: string, status: string | undefined, page = 1, limit = 50) {
		const l = clamp(limit, 1, 200, 50), off = (Math.max(1, page) - 1) * l;
		const where = status ? "campaign_id = ? AND status = ?" : "campaign_id = ?";
		const args = status ? [campaignId, status] : [campaignId];
		return {
			leads: this.q<Lead>(`SELECT id, email, name, company, role, status, step, next_send_at, last_sent_at FROM leads WHERE ${where} ORDER BY created_at LIMIT ? OFFSET ?`, ...args, l, off),
			total: this.one<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE ${where}`, ...args)?.n ?? 0,
		};
	}

	analyzeLeads(campaignId: string) {
		const rows = this.q<Lead>("SELECT email, name, company, role, notes, status FROM leads WHERE campaign_id = ?", campaignId);
		const domains = new Map<string, number>();
		for (const r of rows) { const d = r.email.split("@")[1]; domains.set(d, (domains.get(d) ?? 0) + 1); }
		return {
			total: rows.length,
			withName: rows.filter((r) => r.name).length, withCompany: rows.filter((r) => r.company).length, withNotes: rows.filter((r) => r.notes).length,
			byStatus: rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}),
			topDomains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, count]) => ({ domain, count })),
			tip: rows.length && rows.filter((r) => r.notes).length < rows.length / 2 ? "Add a notes/context column: emails are far more personal when each lead has a real talking point." : null,
		};
	}

	setLeadStatus(leadId: string, status: string, reason: string, now = Date.now()) {
		const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", leadId);
		if (!lead) return;
		this.run("UPDATE leads SET status = ?, lock_until = 0 WHERE id = ?", status, leadId);
		this.run("UPDATE messages SET status = 'cancelled' WHERE lead_id = ? AND status IN ('pending_approval','approved')", leadId);
		if (["unsubscribed", "bounced", "invalid"].includes(status)) this.addSuppression(lead.email, status === "unsubscribed" ? "opted out" : status, now);
		this.log(`lead_${status}`, lead.campaign_id, leadId, reason, now);
	}

	// ---------- gate: every rule that stops a send ----------
	private sentToday(alias: string | null, day: string): number {
		return alias
			? this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE from_alias = ? AND status = 'sent' AND sent_day = ?", alias, day)?.n ?? 0
			: this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE status = 'sent' AND sent_day = ?", day)?.n ?? 0;
	}

	/** Returns the reason a campaign may NOT send right now, or null when it may. */
	gate(c: Campaign, now: number): string | null {
		if (c.status !== "active") return "campaign not active";
		if (!this.getSettings().masterEnabled) return "automation is switched off";
		const blocked = this.policy.isSenderBlocked(c.sender_alias);
		if (blocked) return blocked;
		if (c.mode === "auto_send" && !(c.permission_until && c.permission_until > now)) return "auto-send permission missing or expired";
		if (!inSendWindow(now, { tz: c.tz, startHour: c.window_start, endHour: c.window_end, days: c.days.split(",").map(Number) })) return "outside the sending window";
		const sender = this.one<{ first_sent_day: string | null; next_ok_at: number }>("SELECT first_sent_day, next_ok_at FROM senders WHERE alias = ?", c.sender_alias);
		if (sender && sender.next_ok_at > now) return "waiting for the gap between sends";
		const today = dayKey(now, c.tz);
		const age = sender?.first_sent_day ? daysBetweenKeys(sender.first_sent_day, today) : 0;
		if (this.sentToday(c.sender_alias, today) >= effectiveDailyCap(c.daily_cap, age)) return "daily limit reached (warm-up ramp applies)";
		if (this.sentToday(null, today) >= this.getSettings().globalDailyCap) return "global daily limit reached";
		return null;
	}

	private domainLimitHit(email: string, day: string): boolean {
		const domain = email.split("@")[1];
		return (this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE status = 'sent' AND sent_day = ? AND to_email LIKE ?", day, `%@${domain}`)?.n ?? 0) >= MAX_PER_DOMAIN_PER_DAY;
	}

	private recentlyContacted(email: string, now: number): boolean {
		return !!this.one("SELECT 1 FROM messages WHERE to_email = ? AND status = 'sent' AND sent_at > ?", email, now - RECENT_CONTACT_DAYS * DAY_MS);
	}

	recentMessages(campaignId: string, limit = 40) {
		return this.q<{ subject: string; body: string; style: string | null }>(
			"SELECT subject, body, style FROM messages WHERE campaign_id = ? AND status IN ('sent','approved','pending_approval') ORDER BY created_at DESC LIMIT ?", campaignId, limit);
	}

	// ---------- the work queue ----------
	claimNext(now: number): Job | null {
		if (!this.getSettings().masterEnabled) return null;
		this.janitor(now);
		const lock = now + 3 * 60_000;

		// 1) approved drafts waiting for their turn to be sent
		for (const m of this.q<Message>("SELECT m.* FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.status = 'approved' AND c.status = 'active' ORDER BY m.created_at LIMIT 30")) {
			const c = this.getCampaign(m.campaign_id)!;
			const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", m.lead_id);
			if (!lead || lead.lock_until > now || lead.status !== "awaiting_approval") continue;
			if (this.gate(c, now)) continue;
			if (this.domainLimitHit(lead.email, dayKey(now, c.tz))) continue;
			this.run("UPDATE leads SET lock_until = ? WHERE id = ?", lock, lead.id);
			return { kind: "send", campaign: c, lead, message: m };
		}

		// 2) leads due for a (new) email
		for (const c of this.q<Campaign>("SELECT * FROM campaigns WHERE status = 'active' ORDER BY created_at")) {
			const blocked = this.policy.isSenderBlocked(c.sender_alias);
			if (blocked) { this.setStatus(c.id, "paused", blocked, "engine", now); continue; }
			if (c.mode === "draft_only") {
				if ((this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND status = 'pending_approval'", c.id)?.n ?? 0) >= MAX_PENDING_APPROVALS) continue;
			} else if (this.gate(c, now)) continue;

			const today = dayKey(now, c.tz);
			for (const lead of this.q<Lead>("SELECT * FROM leads WHERE campaign_id = ? AND status IN ('new','contacted') AND next_send_at <= ? AND lock_until <= ? ORDER BY next_send_at, created_at LIMIT 25", c.id, now, now)) {
				if (this.isSuppressed(lead.email)) { this.setLeadStatus(lead.id, "skipped", "on the suppression list", now); continue; }
				if (lead.step === 0 && this.recentlyContacted(lead.email, now)) { this.setLeadStatus(lead.id, "skipped", `contacted in the last ${RECENT_CONTACT_DAYS} days`, now); continue; }
				if (c.mode === "auto_send" && this.domainLimitHit(lead.email, today)) continue;
				this.run("UPDATE leads SET lock_until = ? WHERE id = ?", lock, lead.id);
				return {
					kind: "generate", campaign: c, lead, recent: this.recentMessages(c.id, 40),
					previous: this.q("SELECT subject, body, step FROM messages WHERE lead_id = ? AND status = 'sent' ORDER BY step", lead.id),
				};
			}
		}
		return null;
	}

	/** Put a locked lead back in the queue. Pass countFailure=false for harmless waits (e.g. inbox sync is stale). */
	releaseLead(leadId: string, retryAt: number, reason: string, now = Date.now(), countFailure = true) {
		const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", leadId);
		if (!lead) return;
		const fails = lead.fail_count + (countFailure ? 1 : 0);
		if (fails >= 4) return this.setLeadStatus(leadId, "skipped", `gave up: ${reason}`, now);
		this.run("UPDATE leads SET lock_until = 0, next_send_at = ?, fail_count = ? WHERE id = ?", retryAt, fails, leadId);
		this.log("lead_retry", lead.campaign_id, leadId, reason, now);
	}

	/** Unlock a lead whose approved draft could not be sent right now (it stays approved and is retried later). */
	unlockLead(leadId: string) { this.run("UPDATE leads SET lock_until = 0 WHERE id = ?", leadId); }

	/**
	 * Atomically move approved -> sending right before the real send. If anything crashes after this point the message is
	 * never re-sent automatically (it is reviewed by a human instead), so a recipient can never get a duplicate.
	 */
	beginSend(messageId: string): boolean {
		return this.q("UPDATE messages SET status = 'sending' WHERE id = ? AND status = 'approved' RETURNING id", messageId).length === 1;
	}

	/** Messages stuck in 'sending' for 15+ minutes have an unknown outcome: flag them, never retry. */
	private janitor(now: number) {
		for (const m of this.q<Message>("SELECT * FROM messages WHERE status = 'sending' AND created_at < ?", now - 15 * 60_000)) {
			this.run("UPDATE messages SET status = 'failed', error = 'Outcome unknown. Check the Sent folder before retrying.' WHERE id = ?", m.id);
			this.setLeadStatus(m.lead_id, "skipped", "send outcome unknown: not retried to avoid a duplicate", now);
		}
	}

	/** Drafts approved by auto-send permission go stale when automation stops: cancel them and requeue the leads. */
	cancelAutoDrafts(campaignId: string | null, now: number) {
		const where = campaignId ? "AND m.campaign_id = ?" : "";
		const rows = this.q<{ id: string; lead_id: string; step: number }>(
			`SELECT m.id, m.lead_id, m.step FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.status = 'approved' AND c.mode = 'auto_send' ${where}`, ...(campaignId ? [campaignId] : []));
		for (const m of rows) {
			this.run("UPDATE messages SET status = 'cancelled' WHERE id = ?", m.id);
			this.run("UPDATE leads SET status = ?, lock_until = 0, next_send_at = ? WHERE id = ? AND status = 'awaiting_approval'", m.step === 0 ? "new" : "contacted", now, m.lead_id);
		}
	}

	getInboxCursor(): number { return Number(this.getSetting("inbox_cursor", "0")); }
	setInboxCursor(ts: number) { this.setSetting("inbox_cursor", String(ts)); }

	sampleLeads(campaignId: string, n: number) {
		return this.q<Lead>("SELECT * FROM leads WHERE campaign_id = ? AND status = 'new' ORDER BY created_at LIMIT ?", campaignId, clamp(n, 1, 5, 3));
	}

	/** Re-validate everything immediately before the real send. This is the kill-switch checkpoint. */
	canSend(messageId: string, now: number): { ok: boolean; reason?: string } {
		const m = this.one<Message>("SELECT * FROM messages WHERE id = ?", messageId);
		if (!m || m.status !== "approved") return { ok: false, reason: "message is no longer approved" };
		const c = this.getCampaign(m.campaign_id);
		const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", m.lead_id);
		if (!c || !lead) return { ok: false, reason: "missing campaign or lead" };
		if (lead.status !== "awaiting_approval") return { ok: false, reason: `lead is ${lead.status}` };
		if (this.isSuppressed(m.to_email)) return { ok: false, reason: "recipient is suppressed" };
		const g = this.gate(c, now);
		return g ? { ok: false, reason: g } : { ok: true };
	}

	// ---------- drafts ----------
	saveDraft(leadId: string, draft: { subject: string; body: string; style: Style }, now: number) {
		const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", leadId)!;
		const c = this.getCampaign(lead.campaign_id)!;
		const id = uid();
		const status = c.mode === "auto_send" ? "approved" : "pending_approval";
		this.run(
			`INSERT INTO messages (id, lead_id, campaign_id, step, subject, body, style, status, created_at, to_email, from_alias)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, leadId, c.id, lead.step, draft.subject, draft.body, JSON.stringify(draft.style), status, now, lead.email, c.sender_alias);
		this.run("UPDATE leads SET status = 'awaiting_approval', lock_until = ? WHERE id = ?", status === "approved" ? now + 3 * 60_000 : 0, leadId);
		this.log("draft_created", c.id, leadId, `${status}, step ${lead.step}`, now);
		return { messageId: id, status };
	}

	pendingApprovals(campaignId?: string) {
		return this.q(
			`SELECT m.id, m.campaign_id, m.lead_id, m.step, m.subject, m.body, m.to_email, m.from_alias, m.created_at, l.name, l.company
			 FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.status = 'pending_approval' ${campaignId ? "AND m.campaign_id = ?" : ""} ORDER BY m.created_at LIMIT 100`,
			...(campaignId ? [campaignId] : []));
	}

	approveMessage(messageId: string, edits: { subject?: string; body?: string } | undefined, by: string, now = Date.now()) {
		const m = this.one<Message>("SELECT * FROM messages WHERE id = ?", messageId);
		if (!m || m.status !== "pending_approval") throw new Error("This draft is no longer waiting for approval");
		const subject = edits?.subject?.trim() || m.subject;
		const body = edits?.body?.trim() || m.body;
		if (edits?.subject || edits?.body) {
			// An edited draft must pass the same content rules as a generated one.
			const c = this.getCampaign(m.campaign_id)!;
			const problems = lintEmail({ subject, body, step: m.step, allowLinks: !!c.allow_links });
			if (problems.length) throw new Error(`Edit rejected: ${problems.join("; ")}`);
		}
		this.run("UPDATE messages SET status = 'approved', subject = ?, body = ? WHERE id = ?", subject, body, messageId);
		this.log("draft_approved", m.campaign_id, m.lead_id, `by ${by}`, now);
	}

	/** Reject: the lead goes back to the queue and gets a fresh, different draft. */
	rejectMessage(messageId: string, by: string, now = Date.now()) {
		const m = this.one<Message>("SELECT * FROM messages WHERE id = ?", messageId);
		if (!m || m.status !== "pending_approval") throw new Error("This draft is no longer waiting for approval");
		this.run("UPDATE messages SET status = 'rejected' WHERE id = ?", messageId);
		this.run("UPDATE leads SET status = ?, lock_until = 0, next_send_at = ? WHERE id = ?", m.step === 0 ? "new" : "contacted", now, m.lead_id);
		this.log("draft_rejected", m.campaign_id, m.lead_id, `by ${by}`, now);
	}

	// ---------- results ----------
	markSent(messageId: string, now: number) {
		const m = this.one<Message>("SELECT * FROM messages WHERE id = ?", messageId)!;
		const c = this.getCampaign(m.campaign_id)!;
		const day = dayKey(now, c.tz);
		this.run("UPDATE messages SET status = 'sent', sent_at = ?, sent_day = ? WHERE id = ?", now, day, messageId);
		const step = m.step + 1;
		const done = step > c.max_followups;
		this.run("UPDATE leads SET status = ?, step = ?, last_sent_at = ?, next_send_at = ?, lock_until = 0, fail_count = 0 WHERE id = ?",
			done ? "completed" : "contacted", step, now, done ? 0 : now + followupDelayMs(c.followup_gap_days, this.rng), m.lead_id);
		this.run(`INSERT INTO senders (alias, first_sent_day, next_ok_at) VALUES (?, ?, ?)
			ON CONFLICT(alias) DO UPDATE SET next_ok_at = excluded.next_ok_at, first_sent_day = COALESCE(senders.first_sent_day, excluded.first_sent_day)`,
			c.sender_alias, day, now + randomGapMs(c.min_gap_min, c.max_gap_min, this.rng));
		this.setSetting("consecutive_failures", "0");
		this.log("sent", c.id, m.lead_id, `step ${m.step} to ${m.to_email}`, now);
	}

	markFailed(messageId: string, error: string, now: number) {
		const m = this.one<Message>("SELECT * FROM messages WHERE id = ?", messageId)!;
		this.run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", error.slice(0, 300), messageId);
		const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", m.lead_id)!;
		const fails = lead.fail_count + 1;
		if (fails >= 3) this.setLeadStatus(m.lead_id, "skipped", `send failed ${fails} times: ${error}`, now);
		else this.run("UPDATE leads SET status = ?, lock_until = 0, fail_count = ?, next_send_at = ? WHERE id = ?", m.step === 0 ? "new" : "contacted", fails, now + fails * 30 * 60_000, m.lead_id);
		if (/429|limit|quota|rate/i.test(error)) this.run(
			`INSERT INTO senders (alias, first_sent_day, next_ok_at) VALUES (?, NULL, ?) ON CONFLICT(alias) DO UPDATE SET next_ok_at = excluded.next_ok_at`, m.from_alias, now + 60 * 60_000);
		const streak = Number(this.getSetting("consecutive_failures", "0")) + 1;
		this.setSetting("consecutive_failures", String(streak));
		this.log("send_failed", m.campaign_id, m.lead_id, error, now);
		if (streak >= 3) this.setStatus(m.campaign_id, "paused", "3 sends in a row failed: check Zoho and your sending limits", "engine", now);
	}

	skipLead(leadId: string, by: string, now = Date.now()) { this.setLeadStatus(leadId, "skipped", `skipped by ${by}`, now); }

	// ---------- inbox signals ----------
	trackedLeads(now: number) {
		return this.q<{ id: string; email: string; last_sent_at: number }>(
			"SELECT id, email, last_sent_at FROM leads WHERE last_sent_at IS NOT NULL AND last_sent_at > ? AND status IN ('contacted','awaiting_approval','completed')", now - 30 * DAY_MS);
	}

	applyInbound(events: InboundEvent[], now: number) {
		for (const e of events) {
			const lead = this.one<Lead>("SELECT * FROM leads WHERE id = ?", e.leadId);
			if (!lead) continue;
			if (e.type === "ooo") {
				if (lead.status === "contacted") this.run("UPDATE leads SET next_send_at = MAX(next_send_at, ?) WHERE id = ?", now + 7 * DAY_MS, lead.id);
				continue;
			}
			if (["replied", "bounced", "unsubscribed"].includes(lead.status)) continue;
			if (e.type === "replied") this.setLeadStatus(lead.id, "replied", "they replied", now);
			if (e.type === "optout") this.setLeadStatus(lead.id, "unsubscribed", "asked not to be contacted", now);
			if (e.type === "bounce") { this.setLeadStatus(lead.id, "bounced", "email bounced", now); this.autoPauseCheck(lead.campaign_id, now); }
		}
	}

	autoPauseCheck(campaignId: string, now: number) {
		const sent = this.one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND status = 'sent'", campaignId)?.n ?? 0;
		const bounced = this.one<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE campaign_id = ? AND status = 'bounced'", campaignId)?.n ?? 0;
		const c = this.getCampaign(campaignId);
		if (c && c.status === "active" && sent >= 20 && bounced / sent >= 0.03)
			this.setStatus(campaignId, "paused", `High bounce rate (${bounced} of ${sent}). Clean the list before continuing.`, "engine", now);
	}

	// ---------- misc ----------
	getDomainCache(domain: string, now: number): boolean | null {
		const r = this.one<{ mx_ok: number; checked_at: number }>("SELECT mx_ok, checked_at FROM domain_cache WHERE domain = ?", domain);
		return r && now - r.checked_at < 7 * DAY_MS ? !!r.mx_ok : null;
	}
	setDomainCache(domain: string, ok: boolean, now: number) {
		this.run("INSERT INTO domain_cache (domain, mx_ok, checked_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET mx_ok = excluded.mx_ok, checked_at = excluded.checked_at", domain, ok ? 1 : 0, now);
	}
	events(campaignId?: string, limit = 60) {
		return this.q("SELECT ts, type, campaign_id, lead_id, detail FROM events " + (campaignId ? "WHERE campaign_id = ? " : "") + "ORDER BY id DESC LIMIT ?", ...(campaignId ? [campaignId] : []), clamp(limit, 1, 200, 60));
	}
	addEvent(type: string, campaignId: string | null, detail: string, now = Date.now()) { this.log(type, campaignId, null, detail, now); }
	sentTodayAll(day: string): number { return this.sentToday(null, day); }
	senderInfo(alias: string, now: number, tz: string) {
		const s = this.one<{ first_sent_day: string | null; next_ok_at: number }>("SELECT first_sent_day, next_ok_at FROM senders WHERE alias = ?", alias);
		const today = dayKey(now, tz);
		const age = s?.first_sent_day ? daysBetweenKeys(s.first_sent_day, today) : 0;
		return { alias, sentToday: this.sentToday(alias, today), rampCap: effectiveDailyCap(ABSOLUTE_MAX_PER_ALIAS_DAY, age), nextOkAt: s?.next_ok_at ?? 0, ageDays: age };
	}
	isTerminal(status: string): boolean { return TERMINAL.has(status); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS campaigns (
	id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', mode TEXT NOT NULL DEFAULT 'draft_only',
	sender_alias TEXT NOT NULL, sender_name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', postal_address TEXT NOT NULL DEFAULT '',
	brief TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'English', daily_cap INTEGER NOT NULL DEFAULT 20,
	min_gap_min INTEGER NOT NULL DEFAULT 8, max_gap_min INTEGER NOT NULL DEFAULT 20, window_start INTEGER NOT NULL DEFAULT 10,
	window_end INTEGER NOT NULL DEFAULT 17, tz TEXT NOT NULL DEFAULT 'Asia/Kolkata', days TEXT NOT NULL DEFAULT '1,2,3,4,5',
	max_followups INTEGER NOT NULL DEFAULT 2, followup_gap_days INTEGER NOT NULL DEFAULT 4, allow_links INTEGER NOT NULL DEFAULT 0,
	permission_until INTEGER, permission_by TEXT, confirmed_legit INTEGER NOT NULL DEFAULT 0,
	created_by TEXT, created_at INTEGER NOT NULL, paused_reason TEXT
);
CREATE TABLE IF NOT EXISTS leads (
	id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, company TEXT, role TEXT, website TEXT, notes TEXT, extra TEXT,
	status TEXT NOT NULL DEFAULT 'new', step INTEGER NOT NULL DEFAULT 0, next_send_at INTEGER NOT NULL DEFAULT 0, last_sent_at INTEGER,
	lock_until INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS idx_leads_due ON leads (campaign_id, status, next_send_at);
CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, campaign_id TEXT NOT NULL, step INTEGER NOT NULL, subject TEXT, body TEXT, style TEXT,
	status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, sent_day TEXT, to_email TEXT, from_alias TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_day ON messages (status, sent_day);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (to_email, status);
CREATE TABLE IF NOT EXISTS suppression (email TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS senders (alias TEXT PRIMARY KEY, first_sent_day TEXT, next_ok_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, campaign_id TEXT, lead_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS domain_cache (domain TEXT PRIMARY KEY, mx_ok INTEGER, checked_at INTEGER);
`;

/** The only methods callable from outside the Durable Object. Everything else on the class is internal. */
export const PUBLIC_METHODS = [
	"getSettings", "setMaster", "setGlobalCap", "createCampaign", "updateCampaign", "getCampaign", "confirmLegit", "listCampaigns", "campaignStats",
	"setStatus", "grantPermission", "revokePermission", "isSuppressed", "addSuppression", "suppressionCount", "importLeads", "listLeads", "analyzeLeads",
	"setLeadStatus", "gate", "recentMessages", "claimNext", "releaseLead", "unlockLead", "beginSend", "cancelAutoDrafts", "getInboxCursor", "setInboxCursor",
	"sampleLeads", "canSend", "saveDraft", "pendingApprovals", "approveMessage", "rejectMessage", "markSent", "markFailed", "skipLead", "trackedLeads",
	"applyInbound", "autoPauseCheck", "getDomainCache", "setDomainCache", "events", "addEvent", "sentTodayAll", "senderInfo",
] as const;
