import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { addAssignment } from "../workers/access/store";
import { auth } from "../workers/auth";
import { readSession } from "../workers/auth/session";
import { makeEnv, seedTokens } from "./helpers";

let privateKey: CryptoKey; let jwk: any; const realFetch = globalThis.fetch;
before(async () => {
	const kp = await generateKeyPair("RS256");
	privateKey = kp.privateKey;
	jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function idToken(claims: any, aud = "gid") {
	return new SignJWT({ email_verified: true, ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer("https://accounts.google.com").setAudience(aud).setSubject("123").setIssuedAt().setExpirationTime("1h").sign(privateKey);
}
function mockGoogle(token: string) {
	globalThis.fetch = (async (input: any) => {
		const url = String(input);
		if (url.includes("googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
		if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ id_token: token }), { headers: { "content-type": "application/json" } });
		return new Response("unmocked " + url, { status: 404 });
	}) as any;
}
const callback = (env: any, state = "s1", cookie = "g_state=s1") =>
	auth.request(`http://localhost/auth/google/callback?code=c&state=${state}`, { headers: { cookie } }, env);
const sessionOf = async (env: any, res: Response) => {
	const m = (res.headers.get("set-cookie") ?? "").match(/session=([^;]+)/);
	return m ? readSession(env, m[1]) : null;
};

test("login page redirects to Google with state cookie", async () => {
	const { env } = makeEnv();
	const res = await auth.request("http://localhost/auth/login", {}, env);
	assert.equal(res.status, 302);
	assert.match(res.headers.get("location")!, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
	assert.match(res.headers.get("set-cookie")!, /g_state=/);
});

test("development login route is unavailable in the production test build", async () => {
	const { env } = makeEnv();
	const res = await auth.request("http://localhost/auth/dev-login", {}, env);
	assert.equal(res.status, 404);
	assert.equal(res.headers.get("set-cookie"), null);
});

test("admin: first login goes to Zoho connect, later logins go home", async () => {
	const { env } = makeEnv();
	mockGoogle(await idToken({ email: "NakmediaCo@gmail.com" }));
	let res = await callback(env);
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), "/auth/zoho");
	assert.deepEqual(await sessionOf(env, res), { email: "nakmediaco@gmail.com", role: "admin" });
	await seedTokens(env);
	res = await callback(env);
	assert.equal(res.headers.get("location"), "/");
});

test("assigned Google account logs in as a user; unassigned account is refused", async () => {
	const { env } = makeEnv();
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	mockGoogle(await idToken({ email: "sam@gmail.com" }));
	let res = await callback(env);
	assert.equal(res.headers.get("location"), "/");
	assert.deepEqual(await sessionOf(env, res), { email: "sam@gmail.com", role: "user" });

	mockGoogle(await idToken({ email: "stranger@gmail.com" }));
	res = await callback(env);
	assert.equal(res.status, 403);
	assert.equal(res.headers.get("set-cookie")?.includes("session="), false);
});

test("login is refused for bad state, unverified email, or wrong audience", async () => {
	const { env } = makeEnv();
	mockGoogle(await idToken({ email: "nakmediaco@gmail.com" }));
	assert.equal((await callback(env, "WRONG")).status, 400);
	assert.equal((await auth.request("http://localhost/auth/google/callback?code=c&state=s1", {}, env)).status, 400);
	mockGoogle(await idToken({ email: "nakmediaco@gmail.com", email_verified: false }));
	assert.equal((await callback(env)).status, 403);
	mockGoogle(await idToken({ email: "nakmediaco@gmail.com" }, "someone-elses-client"));
	assert.equal((await callback(env)).status, 403);
});

test("revoked user cannot log in again", async () => {
	const { env } = makeEnv();
	mockGoogle(await idToken({ email: "gone@gmail.com" }));
	assert.equal((await callback(env)).status, 403);
});

test("zoho connect requires an admin session", async () => {
	const { env } = makeEnv();
	const res = await auth.request("http://localhost/auth/zoho", {}, env);
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), "/auth/login");
});
