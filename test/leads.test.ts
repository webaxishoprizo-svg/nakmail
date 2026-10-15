import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeActivity } from "../workers/lib/analytics";
import { scoreThreads, type ScoringRow } from "../workers/lib/scoring";

const NOW = new Date("2026-10-12T10:00:00Z");
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
let n = 0;
const row = (p: Partial<ScoringRow> & { thread_id: string }): ScoringRow => ({
	id: `m${++n}`, folder_id: "inbox", subject: "", sender: "x@ext.com", recipient: "connect@nakmedia.co", cc: null,
	date: ago(0, 1), read: false, starred: false, snippet: "", ...p,
});
const ME = "connect@nakmedia.co";
const score = (rows: ScoringRow[], customers?: any) => scoreThreads(rows, { mailbox: ME, now: NOW, customers });
const only = (rows: ScoringRow[], customers?: any) => score(rows, customers)[0];

test("regular customer replying to our quote is HOT", () => {
	const customers = { emails: new Set(["buyer@acme.com"]), domains: new Set<string>() };
	const t = only([
		row({ thread_id: "t", folder_id: "sent", sender: ME, recipient: "buyer@acme.com", subject: "Quote", date: ago(2), read: true }),
		row({ thread_id: "t", sender: "buyer@acme.com", subject: "Re: Quote", snippet: "Thanks, please confirm the price", date: ago(0, 2) }),
	], customers);
	assert.equal(t.level, "hot");
	assert.ok(t.score >= 70);
	for (const s of ["Replied to our email", "Regular customer", "Waiting for your reply"]) assert.ok(t.signals.includes(s), s);
});

test("a new enquiry with buying words is WARM; a support request is WARM", () => {
	const enquiry = only([row({ thread_id: "a", sender: "new@lead.com", subject: "Pricing for your service", snippet: "We are interested in pricing" })]);
	assert.equal(enquiry.level, "warm");
	const support = only([row({ thread_id: "b", sender: "cust@x.com", subject: "Help: app not working", snippet: "I get an error" })]);
	assert.equal(support.level, "warm");
	assert.ok(support.signals.includes("Support request"));
});

test("small talk, newsletters, auto-replies and unanswered outbound are COLD", () => {
	assert.equal(only([row({ thread_id: "c", sender: "someone@x.com", subject: "Hello", snippet: "just saying hi" })]).level, "cold");

	const news = only([row({ thread_id: "d", sender: "noreply@shop.com", subject: "50% off pricing sale", snippet: "unsubscribe here" })]);
	assert.equal(news.level, "cold"); assert.ok(news.score <= 10);

	const ooo = only([
		row({ thread_id: "e", folder_id: "sent", sender: ME, recipient: "jane@x.com", date: ago(1), read: true }),
		row({ thread_id: "e", sender: "jane@x.com", subject: "Automatic reply: Out of office", date: ago(0, 1) }),
	]);
	assert.equal(ooo.level, "cold"); assert.ok(ooo.signals.includes("Auto-reply / bounce"));

	const unanswered = only([row({ thread_id: "f", folder_id: "sent", sender: ME, recipient: "p@x.com", read: true })]);
	assert.equal(unanswered.level, "cold"); assert.ok(unanswered.signals.includes("No reply yet"));
});

test("regular contact + keeps in touch are detected from history", () => {
	const who = "r@client.com";
	const rows = [
		row({ thread_id: "t1", folder_id: "sent", sender: ME, recipient: who, date: ago(50), read: true }),
		row({ thread_id: "t1", sender: who, date: ago(45), read: true }),
		row({ thread_id: "t2", folder_id: "sent", sender: ME, recipient: who, date: ago(20), read: true }),
		row({ thread_id: "t2", sender: who, date: ago(18), read: true }),
		row({ thread_id: "t3", sender: who, subject: "Quick question", date: ago(3) }),
	];
	const t3 = score(rows).find((t) => t.thread_id === "t3")!;
	assert.ok(t3.signals.includes("Regular contact"));
	assert.ok(t3.signals.includes("Keeps in touch (3+ threads)"));
	assert.equal(t3.level, "warm");
});

test("old threads fade; alias mailbox outbound is recognised by sender; output is list-shaped and sorted", () => {
	const old = only([
		row({ thread_id: "o", folder_id: "sent", sender: ME, recipient: "z@x.com", date: ago(101), read: true }),
		row({ thread_id: "o", sender: "z@x.com", date: ago(100), read: true }),
	]);
	assert.equal(old.level, "cold");

	const alias = scoreThreads([
		row({ thread_id: "al", folder_id: "archive", sender: "sales@nakmedia.co", recipient: "k@x.com", date: ago(1), read: true }),
		row({ thread_id: "al", sender: "k@x.com", subject: "Re: offer", snippet: "send the quote", date: ago(0, 1) }),
	], { mailbox: "sales@nakmedia.co", now: NOW });
	assert.ok(alias[0].signals.includes("Replied to our email"));

	const mixed = score([
		row({ thread_id: "low", sender: "a@x.com", subject: "hi" }),
		row({ thread_id: "high", folder_id: "sent", sender: ME, recipient: "b@x.com", date: ago(1), read: true }),
		row({ thread_id: "high", sender: "b@x.com", subject: "Re: proposal", snippet: "deadline is urgent", date: ago(0, 1) }),
	]);
	assert.equal(mixed[0].thread_id, "high");
	const t = mixed[0];
	for (const k of ["id", "subject", "sender", "recipient", "date", "read", "starred", "thread_id", "folder_id", "snippet", "thread_count", "thread_unread_count", "participants", "score", "level", "signals"]) assert.ok(k in t, k);
	assert.equal(t.thread_count, 2);
});

test("customer domains match", () => {
	const t = only([row({ thread_id: "dd", sender: "anyone@bigco.com", subject: "invoice", snippet: "payment sent" })], { emails: new Set(), domains: new Set(["bigco.com"]) });
	assert.ok(t.signals.includes("Regular customer"));
});

test("activity counts use the business timezone (IST day boundary)", () => {
	const now = new Date("2026-10-12T19:00:00Z"); // 00:30 IST on Oct 13
	const rows = [
		{ folder_id: "sent", date: "2026-10-12T18:00:00Z" },   // 23:30 IST Oct 12 -> yesterday
		{ folder_id: "sent", date: "2026-10-12T19:00:00Z" },   // Oct 13 -> today
		{ folder_id: "inbox", date: "2026-10-12T20:00:00Z" },  // Oct 13 -> today
		{ folder_id: "trash", date: "2026-10-12T20:00:00Z" },  // ignored
		{ folder_id: "sent", date: "2026-09-01T00:00:00Z" },   // outside window
	];
	const a = summarizeActivity(rows, "Asia/Kolkata", now);
	assert.deepEqual([a.today.date, a.today.sent, a.today.received], ["2026-10-13", 1, 1]);
	assert.deepEqual([a.yesterday.date, a.yesterday.sent], ["2026-10-12", 1]);
	assert.equal(a.last7.sent, 2);
	assert.equal(a.byDay.length, 7);
});
