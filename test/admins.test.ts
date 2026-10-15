import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { mailboxAuthz } from "../workers/access/authz";
import { canSendAs, clearSenderCache, sendersFor } from "../workers/access/senders";
import { addAssignment } from "../workers/access/store";
import { canAdminOpen, visibleMailboxes } from "../workers/access/visibility";
import { auth } from "../workers/auth";
import { startSession } from "../workers/auth/session";
import { sendEmail } from "../workers/email-sender";
import { validateSender } from "../workers/lib/email-helpers";
import { loadTokens } from "../workers/zoho/store";
import { syncZoho } from "../workers/zoho/sync";
import { makeEnv, mockZoho, PRIMARY, SECOND, seedTokens } from "./helpers";

let zoho: ReturnType<typeof mockZoho> | undefined;
const realFetch = globalThis.fetch;
afterEach(() => { zoho?.restore(); zoho = undefined; globalThis.fetch = realFetch; clearSenderCache(); });

const ADMIN1 = { email: "nakmediaco@gmail.com", role: "admin" as const };
const ADMIN2 = { email: "nexusqteam@gmail.com", role: "admin" as const };
const folders = [{ folderId: "1", folderName: "Inbox", folderType: "Inbox" }, { folderId: "2", folderName: "Sent", folderType: "Sent" }];
const msg = (id: string, to: string, extra: any = {}) => ({ messageId: id, folderId: "1", subject: "S" + id, fromAddress: "x@ext.com", toAddress: to, ccAddress: "Not Provided", receivedTime: String(Date.UTC(2026, 9, 1, 12, 0, Number(id))), status: "0", ...extra });

// ---------- login ----------
let privateKey: CryptoKey; let jwk: any;
before(async () => {
	const kp = await generateKeyPair("RS256");
	privateKey = kp.privateKey;
	jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});
async function googleLogin(env: any, email: string) {
	const idToken = await new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer("https://accounts.google.com").setAudience("gid").setSubject("1").setIssuedAt().setExpirationTime("1h").sign(privateKey);
	const inner = globalThis.fetch;
	globalThis.fetch = (async (input: any, init?: any) => {
		const u = String(input);
		if (u.includes("googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [jwk] }));
		if (u.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ id_token: idToken }));
		return inner(input, init);
	}) as any;
	try { return await auth.request("http://localhost/auth/google/callback?code=c&state=s1", { headers: { cookie: "g_state=s1" } }, env); }
	finally { globalThis.fetch = inner; }
}

test("second admin logs in as admin and is sent to Zoho until THEIR mailbox is connected", async () => {
	const { env } = makeEnv();
	await seedTokens(env, PRIMARY);                 // primary already connected: must not matter
	let res = await googleLogin(env, "nexusqteam@gmail.com");
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), "/auth/zoho");
	assert.match(res.headers.get("set-cookie")!, /session=/);
	await seedTokens(env, SECOND);
	res = await googleLogin(env, "nexusqteam@gmail.com");
	assert.equal(res.headers.get("location"), "/");
});

test("Zoho connect for the second admin only accepts admin@nakmedia.co and stores it under that account", async () => {
	const { env } = makeEnv();
	zoho = mockZoho({ folders, messages: {}, addresses: ["sales@nakmedia.co"] }, { [SECOND]: { folders, messages: { "1": [msg("1", SECOND)] }, addresses: [] } });
	const session = await startSession(env, ADMIN2);
	const ctx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); }, passThroughOnException() {} } as any;
	const cb = (code: string) => auth.request(`http://localhost/auth/zoho/callback?code=${code}&state=s1`, { headers: { cookie: `session=${session}; z_state=s1` } }, env, ctx);

	let res = await cb(`code-${PRIMARY}`);           // signed in to the WRONG Zoho account
	assert.equal(res.status, 403);
	assert.equal(await loadTokens(env, SECOND), null);
	assert.equal(await loadTokens(env, PRIMARY), null);

	res = await cb(`code-${SECOND}`);
	assert.equal(res.status, 302);
	assert.equal((await loadTokens(env, SECOND))?.refresh_token, `RT-${SECOND}`);
	assert.equal(await loadTokens(env, PRIMARY), null);   // primary untouched
});

// ---------- sync ----------
test("each admin's Zoho syncs into their OWN mailbox; only the primary fans out to aliases", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env, PRIMARY); await seedTokens(env, SECOND);
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	zoho = mockZoho(
		{ folders, messages: { "1": [msg("1", "sales@nakmedia.co"), msg("2", PRIMARY)] } },
		{ [SECOND]: { folders, messages: { "1": [msg("10", SECOND), msg("11", "sales@nakmedia.co")] } } },
	);
	const r = await syncZoho(env);
	assert.equal(r.errors, 0);
	const ids = (a: string) => boxes.get(a)!.emails.map((e) => e.id).sort();
	assert.deepEqual(ids(PRIMARY), ["z-1", "z-2"]);
	assert.deepEqual(ids(SECOND), ["z-10", "z-11"]);
	assert.deepEqual(ids("sales@nakmedia.co"), ["z-1"]);   // not z-11: admin@'s account is not an alias source
});

test("an unconnected admin is skipped; a failing account does not block the other", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env, PRIMARY);                      // SECOND not connected
	zoho = mockZoho({ folders, messages: { "1": [msg("1", PRIMARY)] } });
	assert.deepEqual(await syncZoho(env), { synced: 1, errors: 0 });
	zoho.restore();

	await seedTokens(env, SECOND);
	zoho = mockZoho({ folders, messages: { "1": [msg("2", PRIMARY)] } }, { [SECOND]: { failFolders: true } });
	const r = await syncZoho(env);                       // SECOND fails, PRIMARY still syncs
	assert.equal(r.synced, 1); assert.equal(r.errors, 1);
	assert.equal(boxes.get(PRIMARY)!.emails.length, 2);
	await assert.rejects(syncZoho(env, SECOND));         // manual sync of that one account reports the error
});

// ---------- sending ----------
test("sending as an alias uses the primary Zoho account; sending as admin@ uses admin@'s account", async () => {
	const { env } = makeEnv();
	await seedTokens(env, PRIMARY); await seedTokens(env, SECOND);
	zoho = mockZoho({ addresses: [] }, { [SECOND]: {} });
	await sendEmail(env, { to: "c@ext.com", from: "sales@nakmedia.co", subject: "A", text: "hi" } as any);
	await sendEmail(env, { to: "c@ext.com", from: { email: SECOND, name: "Admin" }, subject: "B", text: "hi" } as any);
	await sendEmail(env, { to: "c@ext.com", from: PRIMARY, subject: "C", text: "hi" } as any);
	assert.deepEqual(zoho.sends.map((s) => [s.account, s.body.fromAddress]), [[PRIMARY, "sales@nakmedia.co"], [SECOND, SECOND], [PRIMARY, PRIMARY]]);
});

test("senders: admin may send as any alias but never as another admin; a user only as their alias", async () => {
	const { env } = makeEnv();
	await seedTokens(env, PRIMARY);
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	zoho = mockZoho({ addresses: ["sales@nakmedia.co", "support@nakmedia.co", PRIMARY, SECOND, "me@gmail.com"] });

	assert.deepEqual(await sendersFor(env, ADMIN1, PRIMARY), [PRIMARY, "sales@nakmedia.co", "support@nakmedia.co"]);
	assert.deepEqual(await sendersFor(env, ADMIN2, SECOND), [SECOND, "sales@nakmedia.co", "support@nakmedia.co"]);
	assert.deepEqual(await sendersFor(env, { email: "sam@gmail.com", role: "user" }, "sales@nakmedia.co"), ["sales@nakmedia.co"]);

	assert.equal(await canSendAs(env, ADMIN1, PRIMARY, "support@nakmedia.co"), true);     // Zoho alias nobody is assigned to
	assert.equal(await canSendAs(env, ADMIN2, SECOND, "sales@nakmedia.co"), true);
	assert.equal(await canSendAs(env, ADMIN1, PRIMARY, "ceo@evil.com"), false);           // not an alias
	assert.equal(await canSendAs(env, ADMIN1, PRIMARY, SECOND), false);                   // other admin's personal address
	assert.equal(await canSendAs(env, ADMIN2, SECOND, PRIMARY), false);
	const user = { email: "sam@gmail.com", role: "user" as const };
	assert.equal(await canSendAs(env, user, "sales@nakmedia.co", "sales@nakmedia.co"), true);
	assert.equal(await canSendAs(env, user, "sales@nakmedia.co", "support@nakmedia.co"), false);
	assert.equal(await canSendAs(env, user, "sales@nakmedia.co", PRIMARY), false);
	assert.equal(await canSendAs(env, undefined, PRIMARY, PRIMARY), false);
});

test("senders still work for assigned aliases when Zoho is unreachable", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });   // no tokens => Zoho call fails
	assert.deepEqual(await sendersFor(env, ADMIN1, PRIMARY), [PRIMARY, "sales@nakmedia.co"]);
	assert.equal(await canSendAs(env, ADMIN1, PRIMARY, "sales@nakmedia.co"), true);
	assert.equal(await canSendAs(env, ADMIN1, PRIMARY, "support@nakmedia.co"), false);
});

test("validateSender accepts only the mailbox or an explicitly authorised address", () => {
	assert.equal(validateSender("a@b.com", "sales@nakmedia.co", PRIMARY, ["sales@nakmedia.co"]).fromEmail, "sales@nakmedia.co");
	assert.equal(validateSender("a@b.com", PRIMARY, PRIMARY).fromEmail, PRIMARY);
	assert.throws(() => validateSender("a@b.com", "sales@nakmedia.co", PRIMARY), /not allowed/);
	assert.throws(() => validateSender("a@b.com", "sales@nakmedia.co", PRIMARY, ["support@nakmedia.co"]), /not allowed/);
});

// ---------- visibility ----------
test("admins keep personal mailboxes private by default and share aliases", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	assert.deepEqual(await visibleMailboxes(env, ADMIN1), [PRIMARY, "sales@nakmedia.co"]);
	assert.deepEqual(await visibleMailboxes(env, ADMIN2), [SECOND, "sales@nakmedia.co"]);
	assert.equal(canAdminOpen(env, ADMIN1, SECOND), false);
	assert.equal(canAdminOpen(env, ADMIN2, PRIMARY), false);
	assert.equal(canAdminOpen(env, ADMIN2, "sales@nakmedia.co"), true);

	const shared = { ...env, ADMINS_SHARE_MAILBOXES: "true" };
	assert.equal(canAdminOpen(shared, ADMIN1, SECOND), true);
	assert.deepEqual(await visibleMailboxes(shared, ADMIN1), [PRIMARY, SECOND, "sales@nakmedia.co"]);
});

test("mailbox authorization middleware applies the admin rule", async () => {
	const { env } = makeEnv();
	const run = (session: any, id: string) => {
		const app = new Hono<any>();
		app.use("*", async (c, next) => { c.set("session", session); await next(); });
		app.use("/m/:mailboxId/*", mailboxAuthz);
		app.get("/m/:mailboxId/emails", (c) => c.text("ok"));
		return app.request(`/m/${id}/emails`, {}, env).then((r) => r.status);
	};
	assert.equal(await run(ADMIN1, PRIMARY), 200);
	assert.equal(await run(ADMIN1, SECOND), 403);
	assert.equal(await run(ADMIN2, SECOND), 200);
	assert.equal(await run(ADMIN2, PRIMARY), 403);
	assert.equal(await run(ADMIN2, "sales@nakmedia.co"), 200);
	assert.equal(await run(ADMIN2, "SALES%40nakmedia.co"), 200);
});
