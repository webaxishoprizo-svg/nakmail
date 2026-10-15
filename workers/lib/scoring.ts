// Lead priority scoring: every thread gets a 0-100 score from explainable signals.
// Hot >= 70, Warm 40-69. Pure functions (no I/O) so the weights are easy to tune and test.
import { extractAddresses } from "../zoho/matching";

export const HOT = 70;
export const WARM = 40;

export interface ScoringRow {
	id: string; thread_id: string; folder_id: string;
	subject: string | null; sender: string | null; recipient: string | null; cc: string | null;
	date: string; read: boolean; starred: boolean; snippet: string | null;
}

export interface Customers { emails: Set<string>; domains: Set<string> }
export interface ScoreContext { mailbox: string; now: Date; customers?: Customers }
export type Level = "hot" | "warm" | "cold";

export interface ScoredThread {
	id: string; subject: string; sender: string; recipient: string; date: string;
	read: boolean; starred: boolean; thread_id: string; folder_id: string; snippet: string;
	thread_count: number; thread_unread_count: number; participants: string;
	score: number; level: Level; signals: string[];
}

const DAY = 86_400_000;
const AUTOMATED_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|newsletter|news|updates?|alerts?|automated|system|marketing)@/i;
const BULK_BODY = /(unsubscribe|view (this )?(email )?in (your )?browser|manage (your )?(email )?preferences)/i;
const AUTO_REPLY = /(auto[- ]?reply|automatic reply|out of office|undeliverable|delivery (status|failure)|mail delivery (failed|subsystem)|returned mail|failure notice)/i;
const BUYING = /\b(quote|quotation|pricing|price|proposal|invoice|payment|order|purchase|buy|contract|demo|meeting|call|schedule|interested|budget|deadline|urgent|asap)\b/i;
const SUPPORT = /\b(support|help|issue|problem|not working|error|refund|complaint|delivery|cancel|ticket)\b/i;

const firstAddr = (s: string | null | undefined) => [...extractAddresses(s)][0] ?? "";

function isAutomated(r: ScoringRow): boolean {
	return AUTOMATED_SENDER.test(firstAddr(r.sender)) || BULK_BODY.test(r.snippet ?? "");
}

function isCustomer(c: Customers | undefined, addr: string): boolean {
	if (!c || !addr) return false;
	return c.emails.has(addr) || c.domains.has(addr.split("@")[1] ?? "");
}

export function scoreThreads(rows: ScoringRow[], ctx: ScoreContext): ScoredThread[] {
	const mailbox = ctx.mailbox.toLowerCase();
	const now = ctx.now.getTime();
	const isOut = (r: ScoringRow) => r.folder_id === "sent" || firstAddr(r.sender) === mailbox;

	const threads = new Map<string, ScoringRow[]>();
	for (const r of rows) {
		const list = threads.get(r.thread_id) ?? [];
		list.push(r);
		threads.set(r.thread_id, list);
	}
	for (const list of threads.values()) list.sort((a, b) => a.date.localeCompare(b.date));

	// Relationship stats per correspondent (who writes to us, in how many threads, and since when).
	const recentThreads = new Map<string, Set<string>>();
	const repliedThreads = new Map<string, Set<string>>();
	const span = new Map<string, { first: number; last: number }>();
	for (const [tid, list] of threads) {
		const hasOut = list.some(isOut);
		for (const m of list) {
			if (isOut(m)) continue;
			const a = firstAddr(m.sender);
			if (!a) continue;
			const t = new Date(m.date).getTime();
			if (now - t <= 90 * DAY) (recentThreads.get(a) ?? recentThreads.set(a, new Set()).get(a)!).add(tid);
			if (hasOut) (repliedThreads.get(a) ?? repliedThreads.set(a, new Set()).get(a)!).add(tid);
			const s = span.get(a) ?? { first: t, last: t };
			span.set(a, { first: Math.min(s.first, t), last: Math.max(s.last, t) });
		}
	}

	const out: ScoredThread[] = [];
	for (const [tid, list] of threads) {
		const inbound = list.filter((m) => !isOut(m));
		const human = inbound.filter((m) => !isAutomated(m));
		const latest = list[list.length - 1];
		const signals: string[] = [];
		let score = 0;
		const add = (pts: number, label: string) => { score += pts; signals.push(label); };

		if (human.length > 0) {
			const lastHuman = human[human.length - 1];
			const who = firstAddr(lastHuman.sender);
			const ageDays = (now - new Date(lastHuman.date).getTime()) / DAY;
			const text = human.slice(-2).map((m) => `${m.subject ?? ""} ${m.snippet ?? ""}`).join(" ");

			add(10, "Real person writing to you");
			const firstOut = list.findIndex(isOut);
			if (firstOut >= 0 && list.slice(firstOut).some((m) => !isOut(m) && !isAutomated(m))) add(30, "Replied to our email");
			if (human.length >= 4) add(20, `Active conversation (${human.length} messages)`);
			else if (human.length >= 2) add(10, `Back-and-forth (${human.length} messages)`);

			if (ageDays <= 1) add(15, "Wrote in the last 24h");
			else if (ageDays <= 3) add(12, "Wrote in the last 3 days");
			else if (ageDays <= 7) add(8, "Wrote this week");
			else if (ageDays <= 30) add(3, "Wrote this month");

			if (BUYING.test(text)) add(15, "Buying / scheduling words");
			if (SUPPORT.test(text)) add(12, "Support request");
			if (!isOut(latest)) add(8, "Waiting for your reply");
			if (list.some((m) => m.starred)) add(10, "Starred by you");

			if (isCustomer(ctx.customers, who)) add(25, "Regular customer");
			else {
				const replied = repliedThreads.get(who)?.size ?? 0;
				const s = span.get(who);
				if (replied >= 2 && s && s.last - s.first >= 30 * DAY) add(15, "Regular contact");
			}
			if ((recentThreads.get(who)?.size ?? 0) >= 3) add(10, "Keeps in touch (3+ threads)");

			if (ageDays > 90) add(-25, "Old thread");
			else if (ageDays > 60) add(-15, "Older thread");
		} else {
			signals.push(inbound.length ? "Automated sender" : "No reply yet");
		}
		if (inbound.some((m) => AUTO_REPLY.test(`${m.subject ?? ""}`))) add(-40, "Auto-reply / bounce");

		score = Math.max(0, Math.min(100, score));
		if (human.length === 0) score = Math.min(score, 10);
		const level: Level = score >= HOT ? "hot" : score >= WARM ? "warm" : "cold";

		const participants = [...new Set(list.map((m) => firstAddr(m.sender)).filter(Boolean))].join(",");
		out.push({
			id: latest.id, subject: latest.subject ?? "", sender: latest.sender ?? "", recipient: latest.recipient ?? "",
			date: latest.date, read: inbound.every((m) => m.read), starred: list.some((m) => m.starred),
			thread_id: tid, folder_id: latest.folder_id, snippet: latest.snippet ?? "",
			thread_count: list.length, thread_unread_count: inbound.filter((m) => !m.read).length,
			participants, score, level, signals,
		});
	}
	return out.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
}
