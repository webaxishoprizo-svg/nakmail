import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ABSOLUTE_MAX_PER_ALIAS_DAY, HARD_MIN_GAP_MIN, classifyInbound, effectiveDailyCap, followupDelayMs, inSendWindow, isSenderBlocked, lintEmail,
	mapLeadTable, parseCsv, pickStyle, rampCap, randomGapMs, repeatsRecent, similarity, validateLeadEmail, type Style,
} from "../workers/automation/rules";
import { sheetCsvUrl } from "../workers/automation/routes";
import { ADMIN_MAILBOXES, MON_11, goodBody, seeded } from "./autoHelpers";

test("the five never-send addresses (and typo/variants) are blocked; other aliases are fine", () => {
	for (const a of ["admin@nakmedia.co", "connect@nakmedia.co", "support@nakmedia.co", "sales@nakmedia.co", "noreply@nakmedia.co", "noreplay@nakmedia.co", "no-reply@nakmedia.co", "SALES@NAKMEDIA.CO", "support@other.com"])
		assert.ok(isSenderBlocked(a, ADMIN_MAILBOXES), a);
	assert.ok(isSenderBlocked("anyone@nakmedia.co", ADMIN_MAILBOXES, ["anyone@nakmedia.co"]));
	for (const a of ["hello@nakmedia.co", "mubashir@nakmedia.co", "team@nakmedia.co", "supports@nakmedia.co", "salesteam@nakmedia.co"]) assert.equal(isSenderBlocked(a, ADMIN_MAILBOXES), null, a);
});

test("lead emails: role/no-reply and malformed addresses are rejected", () => {
	for (const e of ["", "nope", "a@b", "noreply@x.com", "no-reply@x.com", "abuse@x.com", "postmaster@x.com", "a b@x.com"]) assert.ok(validateLeadEmail(e), e);
	for (const e of ["sam@clinic.in", "dr.rao+x@hospital.co.in", "info@shop.com"]) assert.equal(validateLeadEmail(e), null, e);
});

test("warm-up ramp, daily caps, send gaps and follow-up delays", () => {
	assert.deepEqual([0, 2, 3, 6, 7, 13, 14, 20, 21, 99].map(rampCap), [5, 5, 10, 10, 20, 20, 30, 30, 50, 50]);
	assert.equal(effectiveDailyCap(100, 0), 5);
	assert.equal(effectiveDailyCap(8, 30), 8);
	assert.equal(effectiveDailyCap(500, 30), ABSOLUTE_MAX_PER_ALIAS_DAY);
	const rng = seeded(7);
	const gaps = Array.from({ length: 200 }, () => randomGapMs(1, 2, rng));       // asks for 1 min: floor applies
	assert.ok(gaps.every((g) => g >= HARD_MIN_GAP_MIN * 60_000));
	assert.ok(new Set(gaps).size > 150, "gaps must be varied");
	const fu = Array.from({ length: 100 }, () => followupDelayMs(4, rng));
	assert.ok(fu.every((d) => d >= 3.2 * 86_400_000 && d <= 4.8 * 86_400_000));
});

test("send window respects timezone, hours (end exclusive) and weekdays", () => {
	const w = { tz: "Asia/Kolkata", startHour: 10, endHour: 17, days: [1, 2, 3, 4, 5] };
	assert.equal(inSendWindow(MON_11, w), true);
	assert.equal(inSendWindow(Date.UTC(2026, 9, 12, 4, 29), w), false);          // 09:59 IST
	assert.equal(inSendWindow(Date.UTC(2026, 9, 12, 4, 30), w), true);           // 10:00 IST
	assert.equal(inSendWindow(Date.UTC(2026, 9, 12, 11, 30), w), false);         // 17:00 IST
	assert.equal(inSendWindow(Date.UTC(2026, 9, 17, 5, 30), w), false);          // Saturday
	assert.equal(inSendWindow(Date.UTC(2026, 9, 12, 5, 30), { ...w, tz: "America/New_York" }), false); // 01:30 in New York
});

test("lint accepts a good email and rejects every spam pattern", () => {
	const ok = { subject: "booking for clinics", body: goodBody(), step: 0 };
	assert.deepEqual(lintEmail(ok), []);
	const bad: [string, Partial<typeof ok> & { allowLinks?: boolean }][] = [
		["link", { body: goodBody() + " See https://x.com" }],
		["spam phrase", { body: goodBody() + " It is free to try." }],
		["urgent subject", { subject: "urgent booking help" }],
		["exclamations", { body: goodBody() + " Great! Amazing!" }],
		["markdown", { body: goodBody() + "\n- one\n- two" }],
		["placeholder", { body: goodBody() + " [Your Company]" }],
		["too short", { body: "Hi Sam, would you like to chat about bookings?" }],
		["fake reply subject", { subject: "Re: booking" }],
		["caps subject", { subject: "GREAT booking idea" }],
		["emoji", { body: goodBody() + " 😀" }],
		["html", { body: goodBody() + " <b>hi</b>" }],
		["long subject", { subject: "one two three four five six seven eight nine ten" }],
	];
	for (const [name, o] of bad) assert.ok(lintEmail({ ...ok, ...o }).length > 0, name);
	assert.equal(lintEmail({ ...ok, body: goodBody() + " See https://x.com", allowLinks: true }).length, 0);
	assert.ok(lintEmail({ ...ok, body: goodBody() + " https://a.com https://b.com", allowLinks: true }).length > 0);
	assert.ok(lintEmail({ subject: "quick idea", body: "Hi Sam,\n\nOne short follow-up question about your booking setup. Is it handled by phone today, or do you already use a tool for it?", step: 1 }).length === 0);
});

test("similar wording, same opening and same subject are caught; genuinely different emails pass", () => {
	const a = { subject: "booking for clinics", body: goodBody("alpha") };
	assert.ok(similarity(a.body, a.body) === 1);
	assert.match(repeatsRecent({ subject: "BOOKING for clinics", body: "completely different words here about something else entirely today" }, [a])!, /subject/);
	assert.match(repeatsRecent({ subject: "x1", body: goodBody("alpha").replace("runs appointments", "takes bookings") }, [a])!, /(opening|similar)/);
	const different = { subject: "scheduling question", body: "Hello Priya,\n\nYour reviews mention long waits at reception. We help practices move scheduling online so patients pick their own slot, and it usually takes two weeks to launch.\n\nIs that a problem you are looking at this year?" };
	assert.equal(repeatsRecent(different, [a]), null);
});

test("style picker never repeats the same combination within the last 5 emails", () => {
	const rng = seeded(3);
	const recent: Style[] = [];
	for (let i = 0; i < 300; i++) {
		const s = pickStyle(recent, rng, i % 3);
		const key = (x: Style) => `${x.opening}|${x.structure}|${x.cta}`;
		assert.ok(!recent.slice(0, 5).map(key).includes(key(s)), `repeat at ${i}`);
		recent.unshift(s);
	}
	assert.ok(new Set(recent.map((s) => s.tone)).size === 3);
});

test("inbox classification: reply, out-of-office, opt-out, bounce; older mail and strangers ignored", () => {
	const sent = Date.UTC(2026, 9, 12, 5, 0);
	const leads = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `l${n}`, email: `p${n}@x.com`, last_sent_at: sent }));
	const row = (sender: string, subject: string, body: string, date = sent + 3600_000) => ({ sender, subject, body, date });
	const ev = classifyInbound([
		row("P1 <p1@x.com>", "Re: booking", "Sounds interesting, tell me more"),
		row("p2@x.com", "Automatic reply: Out of office", "I am away"),
		row("p3@x.com", "Re: booking", "Not interested, please stop emailing me"),
		row("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Your message to p4@x.com could not be delivered"),
		row("p5@x.com", "Re: booking", "old reply", sent - 1000),
		row("stranger@y.com", "Re: booking", "hello"),
	], leads);
	const m = Object.fromEntries(ev.map((e) => [e.leadId, e.type]));
	assert.deepEqual(m, { l1: "replied", l2: "ooo", l3: "optout", l4: "bounce" });
	assert.deepEqual(classifyInbound([row("p6@x.com", "Re: x", "no thanks"), row("p6@x.com", "Re: x", "actually, tell me more")], leads).map((e) => e.type), ["optout"]);
});

test("CSV parsing and column mapping (quotes, BOM, delimiters, synonyms, extra columns)", () => {
	const csv = '\uFEFFE-mail;First Name;Last Name;Organisation;Job Title;About;Linkedin\r\n"a@x.com";Sam;Rao;"Rao, Clinic";Owner;"Runs ""the"" clinic";in/sam\r\nb@y.com;;;;;;\r\n';
	const t = parseCsv(csv);
	assert.equal(t.length, 3);
	const { leads, error } = mapLeadTable(t);
	assert.equal(error, undefined);
	assert.deepEqual(leads[0], { email: "a@x.com", name: "Sam Rao", company: "Rao, Clinic", role: "Owner", website: "", notes: 'Runs "the" clinic', extra: { linkedin: "in/sam" } });
	assert.equal(leads[1].email, "b@y.com");
	assert.match(mapLeadTable(parseCsv("name,company\nSam,X")).error!, /email/);
	assert.match(mapLeadTable(parseCsv("email")).error!, /header row/);
	assert.equal(parseCsv("email,name\na@x.com,Sam\n").length, 2);
});

test("Google Sheets links become export URLs; other hosts are refused", () => {
	assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc_123-X/edit#gid=456"), "https://docs.google.com/spreadsheets/d/abc_123-X/export?format=csv&gid=456");
	assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc/edit"), "https://docs.google.com/spreadsheets/d/abc/export?format=csv");
	for (const u of ["https://evil.com/spreadsheets/d/abc", "http://169.254.169.254/x", "not a url", "https://docs.google.com/document/d/abc"]) assert.equal(sheetCsvUrl(u), null, u);
});
