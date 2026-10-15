import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { mailboxAuthz, requireAdmin } from "../workers/access/authz";
import { addAssignment } from "../workers/access/store";
import { makeEnv } from "./helpers";

// Mirrors workers/app.ts (parent sets session) + workers/index.ts (child API app) + app.route("/", child)
function build(session: any) {
	const child = new Hono<any>();
	child.use("/api/v1/mailboxes/:mailboxId", mailboxAuthz);
	child.use("/api/v1/mailboxes/:mailboxId/*", mailboxAuthz);
	child.get("/api/v1/mailboxes/:mailboxId/emails", (c) => c.json({ ok: true, who: c.get("session")?.email }));
	child.get("/api/v1/mailboxes/:mailboxId/api-keys", requireAdmin, (c) => c.text("keys"));
	child.post("/api/v1/mailboxes", requireAdmin, (c) => c.text("created"));
	const parent = new Hono<any>();
	parent.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
	parent.route("/", child);
	parent.all("*", (c) => c.text("spa"));
	return parent;
}

test("session set by the parent app is visible to mounted API routes", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	const app = build({ email: "sam@gmail.com", role: "user" });
	const ok = await app.request("/api/v1/mailboxes/sales@nakmedia.co/emails", {}, env);
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { ok: true, who: "sam@gmail.com" });
	assert.equal((await app.request("/api/v1/mailboxes/connect@nakmedia.co/emails", {}, env)).status, 403);
	assert.equal((await app.request("/api/v1/mailboxes/sales@nakmedia.co/api-keys", {}, env)).status, 403);
	assert.equal((await app.request("/api/v1/mailboxes", { method: "POST" }, env)).status, 403);
});

test("stale administrator role claims no longer authorize admin routes", async () => {
	const { env } = makeEnv();
	const app = build({ email: "former-admin@gmail.com", role: "admin" });
	assert.equal((await app.request("/api/v1/mailboxes/sales@nakmedia.co/api-keys", {}, env)).status, 403);
	assert.equal((await app.request("/api/v1/mailboxes", { method: "POST" }, env)).status, 403);
});

test("without a session the mounted API fails closed", async () => {
	const { env } = makeEnv();
	const app = build(null);
	assert.equal((await app.request("/api/v1/mailboxes/sales@nakmedia.co/emails", {}, env)).status, 401);
});
