// Pure rules for the cold-mail engine: what may be sent, to whom, when, and how it must read.
// Nothing here does I/O, so every rule is unit-tested.

export const DAY_MS = 86_400_000;
export const HARD_MIN_GAP_MIN = 4;          // never closer than 4 minutes between two sends from one alias
export const ABSOLUTE_MAX_PER_ALIAS_DAY = 50;
export const MAX_FOLLOWUPS = 3;
export const MAX_PER_DOMAIN_PER_DAY = 2;
export const MAX_LEADS_PER_CAMPAIGN = 2000;
export const MAX_PENDING_APPROVALS = 10;
export const RECENT_CONTACT_DAYS = 30;       // never re-contact someone emailed in the last 30 days (any campaign)

// ---------- who may send ----------
/** Local parts that must NEVER send cold mail (admin@, connect@, support@, sales@, noreply@ ...). */
export const BLOCKED_LOCALPARTS = new Set(["admin", "connect", "support", "sales", "noreply", "no-reply", "noreplay"]);

export function isSenderBlocked(alias: string, adminMailboxes: string[], extraBlocked: string[] = []): string | null {
	const a = alias.trim().toLowerCase();
	const [local] = a.split("@");
	if (BLOCKED_LOCALPARTS.has(local)) return `${a} is on the never-send list (admin, connect, support, sales, noreply)`;
	if (adminMailboxes.map((m) => m.toLowerCase()).includes(a)) return `${a} is an admin mailbox and cannot be used for cold mail`;
	if (extraBlocked.map((m) => m.trim().toLowerCase()).filter(Boolean).includes(a)) return `${a} is blocked for cold mail`;
	return null;
}

// ---------- who may be emailed ----------
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const ROLE_LOCALPARTS = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|abuse|postmaster|mailer-daemon|spam|spamtrap|bounce[s]?|root|webmaster|hostmaster|privacy|unsubscribe)$/;

export function validateLeadEmail(email: string): string | null {
	const e = email.trim().toLowerCase();
	if (!e) return "empty email";
	if (e.length > 254 || !EMAIL_RE.test(e)) return "invalid email";
	if (ROLE_LOCALPARTS.test(e.split("@")[0])) return "role/no-reply address";
	return null;
}

// ---------- when ----------
export function dayKey(ms: number, tz: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export function localParts(ms: number, tz: string): { weekday: number; hour: number } {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date(ms));
	const wd = parts.find((p) => p.type === "weekday")!.value;
	const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
	return { weekday: WEEKDAYS[wd], hour };
}

export function inSendWindow(ms: number, w: { tz: string; startHour: number; endHour: number; days: number[] }): boolean {
	const { weekday, hour } = localParts(ms, w.tz);
	return w.days.includes(weekday) && hour >= w.startHour && hour < w.endHour;
}

export function daysBetweenKeys(a: string, b: string): number {
	return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
}

/** Warm-up ramp: a brand-new sending alias starts tiny and grows. */
export function rampCap(daysSinceFirstSend: number): number {
	if (daysSinceFirstSend < 3) return 5;
	if (daysSinceFirstSend < 7) return 10;
	if (daysSinceFirstSend < 14) return 20;
	if (daysSinceFirstSend < 21) return 30;
	return ABSOLUTE_MAX_PER_ALIAS_DAY;
}
export const effectiveDailyCap = (campaignCap: number, daysSinceFirstSend: number): number =>
	Math.max(0, Math.min(campaignCap, rampCap(daysSinceFirstSend), ABSOLUTE_MAX_PER_ALIAS_DAY));

/** Random pause before the next send from the same alias (never below the hard floor). */
export function randomGapMs(minMin: number, maxMin: number, rng: () => number): number {
	const lo = Math.max(HARD_MIN_GAP_MIN, minMin);
	const hi = Math.max(lo, maxMin);
	return Math.round((lo + rng() * (hi - lo)) * 60_000 + rng() * 45_000);
}

/** Follow-up delay with +/-20% jitter so follow-ups never land on a fixed rhythm. */
export function followupDelayMs(gapDays: number, rng: () => number): number {
	return Math.round(gapDays * DAY_MS * (0.8 + rng() * 0.4));
}

// ---------- how it must read ----------
const SPAM_PHRASES = [
	"free", "guarantee", "guaranteed", "act now", "limited time", "click here", "buy now", "100%", "risk-free", "risk free",
	"winner", "cash", "earn money", "make money", "no obligation", "urgent", "congratulations", "dear friend", "discount",
	"offer expires", "once in a lifetime", "no cost", "special promotion", "double your", "pre-approved", "order now", "apply now", "exclusive deal",
];
const SPAM_RE = new RegExp(`(^|[^a-z])(${SPAM_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})([^a-z]|$)`, "i");
const LINK_RE = /(https?:\/\/|www\.)\S+/gi;
const PLACEHOLDER_RE = /(\[[^\]\n]{1,40}\]|\{\{|\}\}|<[A-Za-z ]{2,30}>|lorem ipsum|your name here)/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

export const wordCount = (s: string): number => (s.trim().match(/\S+/g) ?? []).length;
const capsWords = (s: string): number => (s.match(/\b[A-Z]{5,}\b/g) ?? []).length;

export interface LintInput { subject: string; body: string; step: number; allowLinks?: boolean }

export function lintEmail({ subject, body, step, allowLinks = false }: LintInput): string[] {
	const errs: string[] = [];
	const s = subject.trim();
	const b = body.trim();
	const sw = wordCount(s);

	if (sw < 1 || sw > 9 || s.length > 60) errs.push("subject must be 1-9 words and at most 60 characters");
	if (/^(re|fwd?|fw)\s*:/i.test(s)) errs.push('subject must not start with "Re:" or "Fwd:" (it is not a reply)');
	if (/[!$]/.test(s) || (s.match(/\?/g) ?? []).length > 1) errs.push("subject must not use ! or $ or several ?");
	if (capsWords(s) > 0) errs.push("subject must not contain ALL-CAPS words");
	if (SPAM_RE.test(s)) errs.push("subject contains a spam-trigger phrase");

	const lo = step === 0 ? 45 : 25;
	const hi = step === 0 ? 150 : 110;
	const bw = wordCount(b);
	if (bw < lo || bw > hi) errs.push(`body must be ${lo}-${hi} words (got ${bw})`);
	if (PLACEHOLDER_RE.test(b) || PLACEHOLDER_RE.test(s)) errs.push("contains a placeholder like [Name] or {{x}}");
	if (SPAM_RE.test(b)) errs.push("body contains a spam-trigger phrase");
	if (capsWords(b) > 1) errs.push("body has too many ALL-CAPS words");
	if ((b.match(/!/g) ?? []).length > 1) errs.push("body has more than one exclamation mark");
	if (EMOJI_RE.test(b) || EMOJI_RE.test(s)) errs.push("no emojis");
	if (/(\*\*|^#{1,6}\s|^\s*[-*•]\s)/m.test(b)) errs.push("plain text only: no markdown or bullet formatting");
	const links = b.match(LINK_RE) ?? [];
	if (links.length > (allowLinks ? 1 : 0)) errs.push(allowLinks ? "at most 1 link" : "no links allowed");
	if (/<\/?[a-z][^>]*>/i.test(b)) errs.push("no HTML");
	return errs;
}

// ---------- never the same pattern ----------
const normWords = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);

export function trigrams(text: string): Set<string> {
	const w = normWords(text);
	const out = new Set<string>();
	for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
	return out;
}

export function similarity(a: string, b: string): number {
	const A = trigrams(a), B = trigrams(b);
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const t of A) if (B.has(t)) inter++;
	return inter / (A.size + B.size - inter);
}

/** Returns a reason if the candidate repeats a recent email's wording, opening line or subject. */
export function repeatsRecent(c: { subject: string; body: string }, recent: { subject: string; body: string }[], threshold = 0.3): string | null {
	const open = normWords(c.body).slice(0, 7).join(" ");
	for (const r of recent) {
		if (c.subject.trim().toLowerCase() === (r.subject ?? "").trim().toLowerCase()) return "same subject as a recent email";
		if (open.length > 0 && open === normWords(r.body ?? "").slice(0, 7).join(" ")) return "same opening line as a recent email";
		if (similarity(c.body, r.body ?? "") >= threshold) return "wording too similar to a recent email";
	}
	return null;
}

export interface Style { opening: string; structure: string; cta: string; tone: string; subject: string; words: number }
export const STYLE_OPTIONS = {
	opening: [
		"open with one specific observation about their company or role (only from the data given)",
		"open with a short direct question relevant to their work",
		"open with one sentence on why you are writing to them specifically",
		"open with a brief honest introduction of who you are, then the reason",
		"open by naming a common challenge for someone in their role",
	],
	structure: [
		"two short paragraphs",
		"three short paragraphs",
		"one short paragraph and a single-line question",
		"problem, then what you do, then a small ask",
	],
	cta: [
		"ask whether this is relevant to them",
		"offer a short call, leaving the timing to them",
		"offer to send more details if useful",
		"ask who is the right person to talk to about this",
		"no direct ask: a soft close that leaves the door open",
	],
	tone: ["warm", "straightforward", "casual but professional"],
	subject: [
		"2-4 lowercase words, no punctuation",
		"a short question",
		"mention their company name",
		"a plain descriptive phrase of 3-6 words",
	],
} as const;

const pick = <T,>(a: readonly T[], rng: () => number): T => a[Math.min(a.length - 1, Math.floor(rng() * a.length))];

/** Pick a style whose (opening, structure, cta) combination was not used in the last 5 emails. */
export function pickStyle(recent: Style[], rng: () => number, step: number): Style {
	const last = recent.slice(0, 5).map((s) => `${s.opening}|${s.structure}|${s.cta}`);
	let s!: Style;
	for (let i = 0; i < 12; i++) {
		s = {
			opening: pick(STYLE_OPTIONS.opening, rng), structure: pick(STYLE_OPTIONS.structure, rng), cta: pick(STYLE_OPTIONS.cta, rng),
			tone: pick(STYLE_OPTIONS.tone, rng), subject: pick(STYLE_OPTIONS.subject, rng),
			words: step === 0 ? 60 + Math.floor(rng() * 70) : 35 + Math.floor(rng() * 50),
		};
		if (!last.includes(`${s.opening}|${s.structure}|${s.cta}`)) break;
	}
	return s;
}

// ---------- reading the inbox ----------
export type InboundType = "replied" | "ooo" | "bounce" | "optout";
const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|sending|contacting|writing)|do not (email|contact)|don'?t (email|contact)|no thanks|not interested|opt[- ]?out|please stop)\b/i;
const AUTO_REPLY = /(auto[- ]?reply|automatic reply|out of office|on vacation|away from (the )?office)/i;
const BOUNCE_SENDER = /(mailer-daemon|postmaster|mail delivery subsystem)/i;
const BOUNCE_SUBJECT = /(undeliverable|delivery status notification|delivery (has )?failed|failure notice|returned mail|could not be delivered|couldn'?t be delivered|address not found)/i;

export interface InboundRow { sender: string; subject: string; body: string; date: number }
export interface TrackedLead { id: string; email: string; last_sent_at: number | null }
export interface InboundEvent { leadId: string; type: InboundType }

const addrOf = (s: string): string => (s.match(/[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i)?.[0] ?? "").toLowerCase();
const RANK: Record<InboundType, number> = { optout: 4, bounce: 3, replied: 2, ooo: 1 };

export function classifyInbound(rows: InboundRow[], leads: TrackedLead[]): InboundEvent[] {
	const byEmail = new Map(leads.map((l) => [l.email.toLowerCase(), l]));
	const best = new Map<string, InboundType>();
	const note = (id: string, t: InboundType) => { if (!best.has(id) || RANK[t] > RANK[best.get(id)!]) best.set(id, t); };

	for (const r of rows) {
		const from = addrOf(r.sender);
		if (BOUNCE_SENDER.test(r.sender) || BOUNCE_SUBJECT.test(r.subject)) {
			const text = `${r.subject} ${r.body}`.toLowerCase();
			for (const l of leads) if (l.last_sent_at && r.date >= l.last_sent_at && text.includes(l.email.toLowerCase())) note(l.id, "bounce");
			continue;
		}
		const lead = byEmail.get(from);
		if (!lead || !lead.last_sent_at || r.date <= lead.last_sent_at) continue;
		const text = `${r.subject}\n${r.body}`;
		if (AUTO_REPLY.test(r.subject)) note(lead.id, "ooo");
		else if (OPT_OUT.test(r.body.slice(0, 600)) || OPT_OUT.test(r.subject)) note(lead.id, "optout");
		else note(lead.id, "replied");
		void text;
	}
	return [...best].map(([leadId, type]) => ({ leadId, type }));
}

// ---------- spreadsheet import ----------
export function parseCsv(text: string, maxRows = Number.POSITIVE_INFINITY): string[][] {
	const src = text.replace(/^\uFEFF/, "");
	const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
	const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
	const rows: string[][] = [];
	let row: string[] = [], cell = "", q = false;
	let reachedRowLimit = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (q) {
			if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
		} else if (ch === '"') q = true;
		else if (ch === delim) { row.push(cell); cell = ""; }
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && src[i + 1] === "\n") i++;
			row.push(cell); cell = "";
			if (row.some((c) => c.trim() !== "")) rows.push(row);
			row = [];
			if (rows.length >= maxRows) { reachedRowLimit = true; break; }
		} else cell += ch;
	}
	if (!reachedRowLimit) {
		row.push(cell);
		if (row.some((c) => c.trim() !== "")) rows.push(row);
	}
	return rows;
}

export interface LeadInput { email: string; name?: string; company?: string; role?: string; website?: string; notes?: string; extra?: Record<string, string> }
const HEADERS: Record<string, string[]> = {
	email: ["email", "e-mail", "email address", "mail", "emailid", "email id"],
	name: ["name", "full name", "contact", "contact name"],
	first: ["first name", "firstname", "first"],
	last: ["last name", "lastname", "last", "surname"],
	company: ["company", "company name", "organization", "organisation", "business"],
	role: ["role", "title", "job title", "designation", "position"],
	website: ["website", "url", "site", "domain"],
	notes: ["notes", "note", "context", "about", "description", "personalization", "personalisation", "insight", "talking point"],
};

export function mapLeadTable(table: string[][]): { leads: LeadInput[]; error?: string } {
	if (table.length < 2) return { leads: [], error: "The sheet needs a header row and at least one lead" };
	const header = table[0].map((h) => h.trim().toLowerCase());
	const col = (key: string) => header.findIndex((h) => HEADERS[key].includes(h));
	const ci = col("email");
	if (ci < 0) return { leads: [], error: 'No "email" column found in the header row' };
	const used = new Set<number>([ci, col("name"), col("first"), col("last"), col("company"), col("role"), col("website"), col("notes")].filter((i) => i >= 0));
	const out: LeadInput[] = [];
	for (const r of table.slice(1)) {
		const get = (k: string) => { const i = col(k); return i >= 0 ? (r[i] ?? "").trim() : ""; };
		const name = get("name") || [get("first"), get("last")].filter(Boolean).join(" ");
		const extra: Record<string, string> = {};
		header.forEach((h, i) => { if (!used.has(i) && h && (r[i] ?? "").trim()) extra[h] = (r[i] ?? "").trim().slice(0, 500); });
		out.push({ email: (r[ci] ?? "").trim().toLowerCase(), name, company: get("company"), role: get("role"), website: get("website"), notes: get("notes").slice(0, 1000), extra });
	}
	return { leads: out };
}
