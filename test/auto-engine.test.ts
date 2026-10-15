import assert from "node:assert/strict";
import { test } from "node:test";
import { runTick, type EngineDeps } from "../workers/automation/engine";
import { inSendWindow } from "../workers/automation/rules";
import { PUBLIC_METHODS, AutomationStore } from "../workers/automation/store";
import { buildFooter, footerIsComplete } from "../workers/automation/writer";
import { DAY, HOUR, MIN, MON_11, baseCampaign, goodBody, goodDraft, leadRows, makeStore, remote } from "./autoHelpers";

type Store = ReturnType<typeof makeStore>;

function setup(o: { over?: Record<string, unknown>; leads?: number; domain?: string; auto?: boolean; seed?: number; oldSender?: boolean } = {}) {
	const store = makeStore(o.seed ?? 1);
	const id = store.createCampaign(baseCampaign({ mode: o.auto ? "auto_send" : "draft_only", ...(o.over ?? {}) }), "admin@x", MON_11);
	store.confirmLegit(id, "admin@x", MON_11);
	store.importLeads(id, leadRows(o.leads ?? 5, o.domain ?? "d{i}.org"), MON_11);
	store.setStatus(id, "active", null, "admin@x", MON_11);
	if (o.auto) store.grantPermission(id, 24 * 30, "admin@x", MON_11);
	store.setMaster(true, "admin@x", MON_11);
	if (o.oldSender) (store as any).run("INSERT INTO senders (alias, first_sent_day, next_ok_at) VALUES (?, '2026-01-01', 0)", baseCampaign().sender_alias);
	return { store, id };
}

function makeDeps(store: Store, clock: { t: number }, o: Partial<EngineDeps> & { sendError?: string } = {}) {
	const sends: { from: string; to: string; subject: string; text: string; at: number }[] = [];
	const d: EngineDeps = {
		now: () => clock.t, store: remote(store),
		write: async (job) => goodDraft(job.lead.email.split("@")[0]),
		send: async (m) => { if (o.sendError) throw new Error(o.sendError); sends.push({ ...m, at: clock.t }); },
		mxOk: async () => true, inbound: async () => [], syncFresh: async () => true, ...o,
	};
	return { d, sends };
}
const leadOf = (store: Store, email: string) => (store as any).one("SELECT * FROM leads WHERE email = ?", email);
const msgs = (store: Store, status?: string) => (store as any).q(`SELECT * FROM messages ${status ? "WHERE status = ?" : ""}`, ...(status ? [status] : []));

test("auto-send: sends one human-checked email, with identity, address and opt-out; never two inside the gap", async () => {
	const { store } = setup({ auto: true });
	const clock = { t: MON_11 };
	const { d, sends } = makeDeps(store, clock);
	assert.equal((await runTick(d)).action, "sent");
	assert.equal(sends.length, 1);
	assert.equal(sends[0].from, "hello@nakmedia.co");
	assert.equal(sends[0].to, "person0@d0.org");
	for (const must of ["Mubashir", "Nakmedia", "12 MG Road, Kochi", "no thanks"]) assert.ok(sends[0].text.includes(must), must + " :: " + JSON.stringify(sends[0].text.slice(-220)));
	assert.equal((await runTick(d)).action, "idle");                       // same minute: waiting for the gap
	clock.t += 2 * MIN;
	assert.equal((await runTick(d)).action, "idle");                       // still inside the minimum 4 minute gap
	clock.t += 25 * MIN;
	assert.equal((await runTick(d)).action, "sent");
	assert.equal(sends.length, 2);
	assert.equal(sends[1].to, "person1@d1.org");
});

test("draft-only: drafts wait for approval, then send; unapproved drafts never send", async () => {
	const { store } = setup();
	const clock = { t: MON_11 };
	const { d, sends } = makeDeps(store, clock);
	assert.equal((await runTick(d)).action, "drafted");
	assert.equal(sends.length, 0);
	const pending: any[] = await (store as any).pendingApprovals();
	assert.equal(pending.length, 1);
	clock.t += HOUR;
	assert.equal((await runTick(d)).action, "drafted");                    // next lead gets a draft; the first stays pending
	assert.equal(sends.length, 0);
	store.approveMessage(pending[0].id, undefined, "admin@x", clock.t);
	assert.equal((await runTick(d)).action, "sent");
	assert.equal(sends.length, 1);
	assert.equal(sends[0].to, pending[0].to_email);
});

test("sequence: follow-ups after the gap, three emails in total, then completed", async () => {
	const { store } = setup({ auto: true, leads: 1 });
	const clock = { t: MON_11 };
	const { d, sends } = makeDeps(store, clock);
	assert.equal((await runTick(d)).action, "sent");
	assert.equal(leadOf(store, "person0@d0.org").status, "contacted");
	clock.t += 2 * DAY; assert.equal((await runTick(d)).action, "idle");  // too early (and Wednesday)
	clock.t = MON_11 + 7 * DAY; assert.equal((await runTick(d)).action, "sent");
	clock.t = MON_11 + 14 * DAY; assert.equal((await runTick(d)).action, "sent");
	assert.equal(sends.length, 3);
	assert.equal(leadOf(store, "person0@d0.org").status, "completed");
	clock.t = MON_11 + 21 * DAY; assert.equal((await runTick(d)).action, "idle");
	assert.equal(sends.length, 3);
});

test("daily cap with warm-up ramp, varied gaps, and only inside the sending window", async () => {
	const { store } = setup({ auto: true, leads: 30, over: { daily_cap: 50 } });
	const clock = { t: MON_11 - 30 * MIN };
	const { d, sends } = makeDeps(store, clock);
	for (let i = 0; i < 9 * 60; i++) { await runTick(d); clock.t += MIN; }   // 09:30 -> 18:30 IST
	assert.equal(sends.length, 5, "a brand-new alias is capped at 5/day by the ramp");
	const w = { tz: "Asia/Kolkata", startHour: 10, endHour: 17, days: [1, 2, 3, 4, 5] };
	assert.ok(sends.every((s) => inSendWindow(s.at, w)));
	const gaps = sends.slice(1).map((s, i) => s.at - sends[i].at);
	assert.ok(gaps.every((g) => g >= 4 * MIN), JSON.stringify(gaps));
	assert.ok(new Set(gaps).size > 1, "gaps must vary");
	clock.t = MON_11 + DAY - 30 * MIN;                                       // Tuesday
	const before = sends.length;
	for (let i = 0; i < 9 * 60; i++) { await runTick(d); clock.t += MIN; }
	assert.equal(sends.length - before, 5);
});

test("per-recipient-domain limit: at most 2 emails a day to one company domain", async () => {
	const { store } = setup({ auto: true, leads: 6, domain: "samecorp.com", over: { daily_cap: 50 }, oldSender: true });
	const clock = { t: MON_11 - 30 * MIN };
	const { d, sends } = makeDeps(store, clock);
	for (let i = 0; i < 9 * 60; i++) { await runTick(d); clock.t += MIN; }
	assert.equal(sends.length, 2);
});

test("outside window / weekend / master off: nothing is sent", async () => {
	for (const t of [Date.UTC(2026, 9, 12, 2, 0), Date.UTC(2026, 9, 17, 6, 0)]) {   // 07:30 IST Monday; Saturday 11:30 IST
		const { store } = setup({ auto: true });
		const { d, sends } = makeDeps(store, { t });
		assert.equal((await runTick(d)).action, "idle");
		assert.equal(sends.length, 0);
	}
	const { store } = setup({ auto: true });
	store.setMaster(false, "admin@x", MON_11);
	const { d, sends } = makeDeps(store, { t: MON_11 });
	assert.equal((await runTick(d)).action, "off");
	assert.equal(sends.length, 0);
});

test("KILL SWITCH: switching off mid-write discards the draft; nothing is sent; auto drafts are cancelled", async () => {
	const { store } = setup({ auto: true });
	const clock = { t: MON_11 };
	const { d, sends } = makeDeps(store, clock, { write: async (job) => { store.setMaster(false, "admin@x", clock.t); return goodDraft(job.lead.email.split("@")[0]); } });
	const r = await runTick(d);
	assert.equal(r.action, "blocked");
	assert.equal(sends.length, 0);
	assert.equal(msgs(store, "approved").length, 0);
	assert.equal(leadOf(store, "person0@d0.org").status, "new");
	// turning it back on does not send the stale draft: a fresh one is written
	store.setMaster(true, "admin@x", clock.t);
	clock.t += 10 * MIN;
	const { d: d2, sends: s2 } = makeDeps(store, clock);
	assert.equal((await runTick(d2)).action, "sent");
	assert.equal(s2.length, 1);
});

test("permission: expiry, revoke and pause stop auto-send; draft-only approvals survive a pause", async () => {
	const { store, id } = setup({ auto: true });
	const clock = { t: MON_11 };
	store.revokePermission(id, "admin@x", clock.t);
	const { d, sends } = makeDeps(store, clock);
	assert.equal((await runTick(d)).action, "idle");                           // auto-send without permission = nothing
	store.grantPermission(id, 1, "admin@x", clock.t);
	clock.t += 2 * HOUR;                                                       // permission expired
	assert.equal((await runTick(d)).action, "idle");
	assert.equal(sends.length, 0);

	const dr = setup({});
	const c2 = { t: MON_11 };
	const x = makeDeps(dr.store, c2);
	await runTick(x.d);
	const p: any[] = dr.store.pendingApprovals();
	dr.store.approveMessage(p[0].id, undefined, "admin@x", c2.t);
	dr.store.setStatus(dr.id, "paused", "test", "admin@x", c2.t);
	assert.equal(msgs(dr.store, "approved").length, 1);                        // human-approved draft is kept
	assert.equal((await runTick(x.d)).action, "idle");
	dr.store.setStatus(dr.id, "active", null, "admin@x", c2.t);
	assert.equal((await runTick(x.d)).action, "sent");
});

test("a reply stops the sequence; opt-out suppresses forever; bounce suppresses", async () => {
	const { store, id } = setup({ auto: true, leads: 3 });
	const clock = { t: MON_11 };
	let inbox: any[] = [];
	const { d, sends } = makeDeps(store, clock, { inbound: async () => inbox });
	for (let i = 0; i < 3; i++) { await runTick(d); clock.t += 20 * MIN; }
	assert.equal(sends.length, 3);
	inbox = [
		{ sender: "Person 0 <person0@d0.org>", subject: "Re: booking", body: "Interesting, tell me more", date: MON_11 + 30 * MIN },
		{ sender: "person1@d1.org", subject: "Re: booking", body: "Not interested, please stop emailing me", date: MON_11 + 30 * MIN },
		{ sender: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", body: "Message to person2@d2.org could not be delivered", date: MON_11 + 40 * MIN },
	];
	clock.t = MON_11 + 2 * HOUR; await runTick(d);
	assert.equal(leadOf(store, "person0@d0.org").status, "replied");
	assert.equal(leadOf(store, "person1@d1.org").status, "unsubscribed");
	assert.equal(leadOf(store, "person2@d2.org").status, "bounced");
	assert.ok(store.isSuppressed("person1@d1.org") && store.isSuppressed("person2@d2.org"));
	assert.ok(!store.isSuppressed("person0@d0.org"));
	// follow-up day: none of them is contacted again
	clock.t = MON_11 + 7 * DAY; await runTick(d); await runTick(d);
	assert.equal(sends.length, 3);
	// and re-importing an opted-out address is refused
	const id2 = store.createCampaign(baseCampaign({ name: "again" }), "admin@x", clock.t);
	const res = store.importLeads(id2, [{ email: "person1@d1.org" }, { email: "person2@d2.org" }, { email: "new@d9.org" }], clock.t);
	assert.deepEqual([res.added, res.suppressed], [1, 2]);
	void id;
});

test("high bounce rate auto-pauses the campaign", async () => {
	const { store, id } = setup({ auto: true, leads: 25, over: { daily_cap: 50 }, oldSender: true });
	const clock = { t: MON_11 - 30 * MIN };
	const { d, sends } = makeDeps(store, clock, { inbound: async () => [] });
	for (let i = 0; i < 9 * 60 && sends.length < 20; i++) { await runTick(d); clock.t += MIN; }
	assert.equal(sends.length, 20);
	store.applyInbound([{ leadId: leadOf(store, sends[0].to).id, type: "bounce" }], clock.t);
	const c: any = store.getCampaign(id);
	assert.equal(c.status, "paused");
	assert.match(c.paused_reason, /bounce rate/i);
});

test("recipient checks: no mail server -> invalid; contacted in another campaign within 30 days -> skipped", async () => {
	const a = setup({ auto: true, leads: 1 });
	const clock = { t: MON_11 };
	const x = makeDeps(a.store, clock, { mxOk: async () => false });
	assert.equal((await runTick(x.d)).action, "invalid");
	assert.equal(leadOf(a.store, "person0@d0.org").status, "invalid");
	assert.ok(a.store.isSuppressed("person0@d0.org"));

	const b = setup({ auto: true, leads: 1 });
	const y = makeDeps(b.store, clock);
	await runTick(y.d);
	const id2 = b.store.createCampaign(baseCampaign({ name: "second", mode: "auto_send" }), "admin@x", clock.t);
	b.store.confirmLegit(id2, "admin@x", clock.t); b.store.grantPermission(id2, 24, "admin@x", clock.t);
	b.store.importLeads(id2, leadRows(1, "d{i}.org"), clock.t);
	b.store.setStatus(id2, "active", null, "admin@x", clock.t);
	clock.t += 30 * MIN;
	await runTick(y.d);
	assert.equal(y.sends.length, 1);
	assert.equal((b.store as any).one("SELECT status FROM leads WHERE campaign_id = ?", id2).status, "skipped");
});

test("writer failures back off and give up; send failures never duplicate and pause after 3 in a row", async () => {
	const a = setup({ auto: true, leads: 1 });
	const clock = { t: MON_11 };
	const x = makeDeps(a.store, clock, { write: async () => ({ error: "bad output" }) });
	const results: string[] = [];
	for (let i = 0; i < 5; i++) { results.push((await runTick(x.d)).action); clock.t += 31 * MIN; }
	assert.deepEqual(results.slice(0, 4), ["writer_failed", "writer_failed", "writer_failed", "writer_failed"]);
	assert.equal(leadOf(a.store, "person0@d0.org").status, "skipped");
	assert.equal(x.sends.length, 0);

	const b = setup({ auto: true, leads: 6, over: { daily_cap: 50 }, oldSender: true });
	const c2 = { t: MON_11 };
	const y = makeDeps(b.store, c2, { sendError: "Zoho API 502" });
	for (let i = 0; i < 5; i++) { await runTick(y.d); c2.t += 10 * MIN; }
	assert.equal(y.sends.length, 0);
	assert.equal(msgs(b.store, "sent").length, 0);
	assert.equal((b.store.getCampaign(b.id) as any).status, "paused");
	assert.match((b.store.getCampaign(b.id) as any).paused_reason, /in a row/);
});

test("follow-ups wait for a fresh inbox sync (so a reply is never missed)", async () => {
	const { store } = setup({ auto: true, leads: 1 });
	const clock = { t: MON_11 };
	let fresh = true;
	const { d, sends } = makeDeps(store, clock, { syncFresh: async () => fresh });
	await runTick(d);
	clock.t = MON_11 + 7 * DAY; fresh = false;
	for (let i = 0; i < 6; i++) { assert.ok(["deferred", "idle"].includes((await runTick(d)).action)); clock.t += 6 * MIN; }
	assert.equal(sends.length, 1);
	assert.equal(leadOf(store, "person0@d0.org").status, "contacted");        // not given up on: waiting is not a failure
	assert.equal(leadOf(store, "person0@d0.org").fail_count, 0);
	fresh = true;
	assert.equal((await runTick(d)).action, "sent");
});

test("NEVER-SEND ADDRESSES: a campaign using one is paused by the engine and sends nothing", async () => {
	for (const alias of ["admin@nakmedia.co", "connect@nakmedia.co", "support@nakmedia.co", "sales@nakmedia.co", "noreply@nakmedia.co", "noreplay@nakmedia.co"]) {
		const { store, id } = setup({ auto: true, over: { sender_alias: alias } });
		const { d, sends } = makeDeps(store, { t: MON_11 });
		assert.equal((await runTick(d)).action, "idle", alias);
		assert.equal(sends.length, 0, alias);
		const c: any = store.getCampaign(id);
		assert.equal(c.status, "paused", alias);
		assert.match(c.paused_reason, /never-send|admin mailbox/, alias);
	}
});

test("pending-approval cap, reject & rewrite, edited drafts must pass the rules", async () => {
	const { store } = setup({ leads: 15 });
	const clock = { t: MON_11 };
	const { d } = makeDeps(store, clock);
	for (let i = 0; i < 15; i++) { await runTick(d); clock.t += MIN; }
	const pending: any[] = store.pendingApprovals();
	assert.equal(pending.length, 10);                                          // never an unbounded pile of drafts
	store.rejectMessage(pending[0].id, "admin@x", clock.t);
	assert.equal(store.pendingApprovals().length, 9);
	await runTick(d);
	assert.equal(store.pendingApprovals().length, 10);                         // the rejected lead gets a fresh draft
	assert.throws(() => store.approveMessage(pending[1].id, { body: goodBody() + " Visit https://spam.example" }, "admin@x", clock.t), /Edit rejected/);
	store.approveMessage(pending[1].id, { body: goodBody("edited") }, "admin@x", clock.t);
	assert.equal(msgs(store, "approved").length, 1);
});

test("no duplicates: sending is atomic; a stuck 'sending' message is flagged for review, never re-sent", async () => {
	const { store } = setup({ auto: true, leads: 1 });
	const clock = { t: MON_11 };
	const job: any = store.claimNext(clock.t);
	const saved = store.saveDraft(job.lead.id, goodDraft("x"), clock.t);
	assert.equal(store.beginSend(saved.messageId), true);
	assert.equal(store.beginSend(saved.messageId), false);                     // second attempt cannot start
	clock.t += 20 * MIN;                                                       // the worker "crashed" before markSent
	assert.equal(store.claimNext(clock.t), null);
	assert.equal(msgs(store, "failed").length, 1);
	assert.match(msgs(store, "failed")[0].error, /Outcome unknown/);
	assert.equal(leadOf(store, "person0@d0.org").status, "skipped");
});

test("only the declared methods are reachable through the Durable Object", () => {
	const proto = Object.getOwnPropertyNames(AutomationStore.prototype).filter((n) => n !== "constructor");
	for (const m of PUBLIC_METHODS) assert.ok(proto.includes(m), m);
	for (const internal of ["q", "one", "run", "log", "getSetting", "setSetting", "sentToday", "domainLimitHit", "recentlyContacted", "janitor"]) assert.ok(!(PUBLIC_METHODS as readonly string[]).includes(internal), internal);
});

test("EVERY footer carries identity, postal address and an opt-out line (regression: it was dropped for ~1/3 of ids)", () => {
	const c = { sender_name: "Mubashir", company: "Nakmedia", postal_address: "12 MG Road, Kochi" };
	const variants = new Set<string>();
	for (let i = 0; i < 3000; i++) {
		const f = buildFooter(c, crypto.randomUUID());
		assert.ok(footerIsComplete(f, c), f);
		assert.ok(f.includes("Nakmedia") && /no thanks/i.test(f));
		variants.add(f.split("\n").pop()!);
	}
	assert.equal(variants.size, 3);                                            // wording still varies
	assert.equal(footerIsComplete("Best,\nMubashir\nno thanks", c), false);   // missing address
	assert.equal(footerIsComplete("Best,\nMubashir\n12 MG Road, Kochi", c), false); // missing opt-out
	assert.ok(footerIsComplete(buildFooter({ ...c, company: "" }, "abc"), c));
});

test("a campaign with no postal address can never send (engine refuses and pauses it)", async () => {
	const { store, id } = setup({ auto: true, over: { postal_address: "" } });
	const { d, sends } = makeDeps(store, { t: MON_11 });
	assert.equal((await runTick(d)).action, "blocked");
	assert.equal(sends.length, 0);
	assert.equal((store.getCampaign(id) as any).status, "paused");
});
