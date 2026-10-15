import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { mailboxAuthz, requireAdmin } from "../workers/access/authz";
import { addAssignment, aliasesFor, allAliases, AccessError, hasAlias, hasAnyAssignment, listAssignments, removeAssignment } from "../workers/access/store";
import { readSession, startSession } from "../workers/auth/session";
import { makeEnv } from "./helpers";

test("assign / list / remove, case-insensitive and idempotent", async () => {
	const { env } = makeEnv();
	assert.equal(await addAssignment(env, { email: " Sam@Gmail.com ", alias: "Sales@NakMedia.co" }), true);
	assert.equal(await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" }), false);
	await addAssignment(env, { email: "sam@gmail.com", alias: "support@nakmedia.co" });
	await addAssignment(env, { email: "li@gmail.com", alias: "sales@nakmedia.co" });
	assert.deepEqual(await aliasesFor(env, "SAM@gmail.com"), ["sales@nakmedia.co", "support@nakmedia.co"]);
	assert.deepEqual(await aliasesFor(env, "li@gmail.com"), ["sales@nakmedia.co"]);
	assert.deepEqual(await allAliases(env), ["sales@nakmedia.co", "support@nakmedia.co"]);
	assert.equal((await listAssignments(env)).length, 3);
	assert.equal(await hasAlias(env, "sam@gmail.com", "sales@nakmedia.co"), true);
	assert.equal(await hasAlias(env, "li@gmail.com", "support@nakmedia.co"), false);
	assert.equal(await removeAssignment(env, { email: "sam@gmail.com", alias: "support@nakmedia.co" }), true);
	assert.equal(await removeAssignment(env, { email: "sam@gmail.com", alias: "support@nakmedia.co" }), false);
	assert.equal(await hasAnyAssignment(env, "nobody@gmail.com"), false);
});

test("one user's prefix never leaks into another's (sam@x vs sam@x.co)", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "a@nakmedia.co" });
	await addAssignment(env, { email: "sam@gmail.com.au", alias: "b@nakmedia.co" });
	assert.deepEqual(await aliasesFor(env, "sam@gmail.com"), ["a@nakmedia.co"]);
	assert.deepEqual(await aliasesFor(env, "sam@gmail.com.au"), ["b@nakmedia.co"]);
});

test("validation rejects bad input", async () => {
	const { env } = makeEnv();
	for (const bad of [
		{ email: "nope", alias: "a@nakmedia.co" },
		{ email: "a@gmail.com", alias: "nope" },
		{ email: "a@gmail.com", alias: "a@other.com" },            // foreign domain
		{ email: "a@gmail.com", alias: "connect@nakmedia.co" },    // main mailbox
		{ email: "nakmediaco@gmail.com", alias: "a@nakmedia.co" }, // admin
		{ email: "nexusqteam@gmail.com", alias: "a@nakmedia.co" }, // second admin
		{ email: "a@gmail.com", alias: "admin@nakmedia.co" },      // second admin's mailbox
		{ email: "a@gmail.com/../x", alias: "a@nakmedia.co" },
	]) await assert.rejects(addAssignment(env, bad), AccessError);
});

test("many assignments paginate correctly", async () => {
	const { env } = makeEnv();
	const config = env.CONFIG.get(env.CONFIG.idFromName("global-config"));
	for (let i = 0; i < 1200; i++) await config.putValue(`access/assign/u${i}%40g.com/a%40nakmedia.co`, "");
	assert.equal((await listAssignments(env)).length, 1200);
});

// ---- middleware, mounted exactly like workers/index.ts ----
function harness(env: any, session: any) {
	const app = new Hono<any>();
	app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
	app.use("/api/v1/mailboxes/:mailboxId", mailboxAuthz);
	app.use("/api/v1/mailboxes/:mailboxId/*", mailboxAuthz);
	app.get("/api/v1/mailboxes/:mailboxId", (c) => c.text("detail"));
	app.get("/api/v1/mailboxes/:mailboxId/emails", (c) => c.text("emails"));
	app.get("/api/v1/mailboxes/:mailboxId/emails/:id/attachments/:a", (c) => c.text("att"));
	app.post("/api/v1/mailboxes", requireAdmin, (c) => c.text("created"));
	const call = (path: string, method = "GET") => app.request(path, { method }, env);
	return call;
}

test("user can open only assigned alias mailbox (all route shapes)", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	const call = harness(env, { email: "sam@gmail.com", role: "user" });
	for (const p of ["", "/emails", "/emails/1/attachments/2"]) {
		assert.equal((await call(`/api/v1/mailboxes/sales@nakmedia.co${p}`)).status, 200, p);
		assert.equal((await call(`/api/v1/mailboxes/SALES%40nakmedia.co${p}`)).status, 200, "encoded+case " + p);
		assert.equal((await call(`/api/v1/mailboxes/support@nakmedia.co${p}`)).status, 403, p);
		assert.equal((await call(`/api/v1/mailboxes/connect@nakmedia.co${p}`)).status, 403, "main " + p);
	}
	assert.equal((await call("/api/v1/mailboxes", "POST")).status, 403);
});

test("revoking takes effect immediately; admin sees everything; no session = 401", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	const user = harness(env, { email: "sam@gmail.com", role: "user" });
	assert.equal((await user("/api/v1/mailboxes/sales@nakmedia.co/emails")).status, 200);
	await removeAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	assert.equal((await user("/api/v1/mailboxes/sales@nakmedia.co/emails")).status, 403);

	const admin = harness(env, { email: "nakmediaco@gmail.com", role: "admin" });
	assert.equal((await admin("/api/v1/mailboxes/connect@nakmedia.co/emails")).status, 200);
	assert.equal((await admin("/api/v1/mailboxes", "POST")).status, 200);
	const anon = harness(env, null);
	assert.equal((await anon("/api/v1/mailboxes/connect@nakmedia.co/emails")).status, 401);
	assert.equal((await anon("/api/v1/mailboxes", "POST")).status, 401);
});

test("a role forged in a cookie is rejected; tampering fails", async () => {
	const { env } = makeEnv();
	const good = await startSession(env, { email: "sam@gmail.com", role: "user" });
	assert.deepEqual(await readSession(env, good), { email: "sam@gmail.com", role: "user" });
	const [h, , sig] = good.split(".");
	const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "sam@gmail.com", role: "admin", iss: "nak-mail", exp: 9999999999 })).toString("base64url")}.${sig}`;
	assert.equal(await readSession(env, forged), null);
	assert.equal(await readSession({ ...env, SESSION_SECRET: "other-secret-other-secret-other-secret" }, good), null);
	assert.equal(await readSession(env, undefined), null);
});
