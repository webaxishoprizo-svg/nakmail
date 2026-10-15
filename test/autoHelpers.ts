import { DatabaseSync } from "node:sqlite";
import { AutomationStore, PUBLIC_METHODS, type Sql } from "../workers/automation/store";
import { isSenderBlocked } from "../workers/automation/rules";
import type { AutomationApi } from "../workers/automation/engine";

export function makeSql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec(q: string, ...b: any[]) {
			const params = b.map((x) => (x === undefined ? null : x));
			if (params.length === 0 && q.includes(";")) { db.exec(q); return []; }
			const st = db.prepare(q);
			if (/^\s*(select|with|pragma)/i.test(q) || /\breturning\b/i.test(q)) return st.all(...params) as any;
			st.run(...params);
			return [];
		},
	};
}

export function seeded(seed = 42) { // mulberry32
	let a = seed;
	return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const ADMIN_MAILBOXES = ["connect@nakmedia.co", "admin@nakmedia.co"];
export const policy = { isSenderBlocked: (a: string) => isSenderBlocked(a, ADMIN_MAILBOXES) };

export function makeStore(seed = 42) { return new AutomationStore(makeSql(), policy, seeded(seed)); }

/** Wrap a store like the Durable Object RPC proxy: async, and only the public methods exist. */
export function remote(store: AutomationStore): AutomationApi {
	const allowed = new Set<string>(PUBLIC_METHODS);
	return new Proxy({} as AutomationApi, {
		get: (_t, name) => (typeof name === "string" && allowed.has(name) ? async (...a: unknown[]) => (store as any)[name](...a) : undefined),
	});
}

// Monday 2026-10-12, 11:00 in India (05:30 UTC): inside a 10-17 weekday window.
export const MON_11 = Date.UTC(2026, 9, 12, 5, 30);
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export const GOOD_BRIEF = "We build fast, affordable websites and booking tools for small clinics. A typical project takes two weeks.";
export function baseCampaign(over: Record<string, unknown> = {}) {
	return {
		name: "Clinics Oct", sender_alias: "hello@nakmedia.co", sender_name: "Mubashir", company: "Nakmedia", postal_address: "12 MG Road, Kochi, Kerala 682016, India",
		brief: GOOD_BRIEF, mode: "draft_only" as const, daily_cap: 20, min_gap_min: 8, max_gap_min: 20, window_start: 10, window_end: 17,
		tz: "Asia/Kolkata", days: [1, 2, 3, 4, 5], max_followups: 2, followup_gap_days: 4, ...over,
	};
}

/** A good 70-word first email body that passes every lint rule. */
export function goodBody(tag = "alpha") {
	return `Hi Sam,\n\nI noticed ${tag} clinic runs appointments by phone, which usually means missed calls and no-shows. We build simple online booking pages for small practices and set them up in about two weeks, with reminders that cut the empty slots.\n\nWould it be useful if I sent a short example of how it looks for a similar clinic? Happy to keep it brief.`;
}
export const goodDraft = (tag = "alpha") => ({
	subject: `booking for ${tag}`, body: goodBody(tag),
	style: { opening: "o", structure: "s", cta: "c", tone: "warm", subject: "x", words: 70 },
});

export function leadRows(n: number, domain = "example.org") {
	return Array.from({ length: n }, (_, i) => ({ email: `person${i}@${domain.replace("{i}", String(i))}`, name: `Person ${i}`, company: `Company ${i}`, notes: "runs a small clinic" }));
}
