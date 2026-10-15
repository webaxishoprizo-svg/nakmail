// Google login (admin only for now) + Zoho connect flow.
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { connectWithCode, zohoAuthUrl, ZohoError } from "../zoho/client";
import { hasAnyAssignment } from "../access/store";
import { adminAccounts, adminForGoogle } from "../config";
import { isZohoConnected } from "../zoho/store";
import { syncZoho } from "../zoho/sync";
import { readSession, SESSION_COOKIE, startSession, type Session } from "./session";
import type { Env } from "../types";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const DEV_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.DEV;

// Who may log in: an admin (any account listed in ADMINS), or any Google account that has at least one alias assigned.
async function roleFor(env: Env, email: string): Promise<Session["role"] | null> {
	if (adminForGoogle(env, email)) return "admin";
	return (await hasAnyAssignment(env, email)) ? "user" : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const page = (msg: string) =>
	`<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px"><p>${esc(msg)}</p><p><a href="/auth/login">Back to login</a></p>`;

const loginPage = () => `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<meta name="color-scheme" content="light">
		<title>Sign in - NAK Mail</title>
		<style>
			* { box-sizing: border-box; }
			html, body { min-height: 100%; }
			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				padding: 24px;
				background: #fff;
				color: #17181b;
				font-family: Arial, Helvetica, sans-serif;
				-webkit-font-smoothing: antialiased;
			}
			.login-card {
				width: min(430px, 100%);
				min-height: 396px;
				padding: 40px 44px 32px;
				background: #f1f3f6;
				border: 1px solid #d5dbe4;
				box-shadow: 0 24px 55px rgb(28 39 55 / 9%);
			}
			.brand { width: max-content; }
			.brand-logo { display: block; width: 155px; height: auto; }
			.brand-caption {
				margin-top: 7px;
				color: #f20d18;
				font-size: 11px;
				font-weight: 600;
				letter-spacing: .31em;
			}
			h1 {
				margin: 17px 0 14px;
				font-size: 19px;
				font-weight: 500;
				letter-spacing: -.04em;
			}
			.intro {
				margin: 0 0 18px;
				color: #596579;
				font-size: 15px;
				line-height: 1.5;
			}
			.google-button {
				min-height: 50px;
				width: 100%;
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 12px;
				border: 1px solid #cfd7e3;
				border-radius: 12px;
				background: #fff;
				color: #17181b;
				font-size: 14px;
				font-weight: 600;
				text-decoration: none;
				transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
			}
			.google-button:hover {
				border-color: #aeb9c9;
				box-shadow: 0 4px 12px rgb(35 48 67 / 8%);
				transform: translateY(-1px);
			}
			.google-button:focus-visible { outline: 3px solid #8aabdf; outline-offset: 3px; }
			.google-icon { width: 18px; height: 18px; flex: 0 0 18px; }
			.notice {
				margin: 9px 0 0;
				color: #687386;
				font-size: 11px;
				line-height: 1.5;
				text-align: center;
			}
			@media (max-width: 520px) {
				body { padding: 16px; }
				.login-card { min-height: 0; padding: 34px 28px 32px; }
				.brand-logo { width: 145px; }
			}
			@media (prefers-reduced-motion: reduce) {
				.google-button { transition: none; }
			}
		</style>
	</head>
	<body>
		<main class="login-card" aria-labelledby="login-title">
			<div class="brand" aria-label="NAK Mail">
				<img class="brand-logo" src="/favicon.png" alt="NAK Mail">
				<div class="brand-caption">NAK MAIL</div>
			</div>
			<h1 id="login-title">EMAIL Dashboard</h1>
			<p class="intro">Sign in with your Google account to continue.</p>
			<a class="google-button" href="/auth/google">
				<svg class="google-icon" viewBox="0 0 48 48" aria-hidden="true">
					<path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.7c3.9-3.6 6-8.8 6-15z"/>
					<path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.7-5.1c-1.8 1.2-4 1.9-6.8 1.9-5.2 0-9.6-3.5-11.2-8.2H5.9v5.2A20 20 0 0 0 24 44z"/>
					<path fill="#FBBC05" d="M12.8 27.7a12 12 0 0 1 0-7.4v-5.2H5.9a20 20 0 0 0 0 17.8l6.9-5.2z"/>
					<path fill="#EA4335" d="M24 12.1c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 6.1 29.5 4 24 4A20 20 0 0 0 5.9 15.1l6.9 5.2c1.6-4.7 6-8.2 11.2-8.2z"/>
				</svg>
				<span>Login with Google</span>
			</a>
			<p class="notice">Unauthorized access is strictly prohibited by NAK Media</p>
		</main>
	</body>
</html>`;

export const auth = new Hono<{ Bindings: Env }>();

auth.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Content-Type-Options", "nosniff");
	await next();
});

const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/", maxAge: 600 };

auth.get("/auth/dev-login", async (c) => {
	// This route is intentionally available only in local Vite development.
	// Never allow it to issue a production administrator session.
	if (!DEV_BUILD) return c.notFound();
	const email = adminAccounts(c.env)[0]?.google ?? "nakmediaco@gmail.com";
	setCookie(c, SESSION_COOKIE, await startSession(c.env, { email, role: "admin" }), {
		path: "/",
		maxAge: 7 * 86400,
		sameSite: "Lax",
		httpOnly: true,
		secure: true,
	});
	return c.redirect("/");
});

auth.get("/auth/login", (c) => c.html(loginPage(), 200, {
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
}));

auth.get("/auth/google", (c) => {
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		return c.html(page("Google sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to this Worker."), 503);
	}
	const state = crypto.randomUUID();
	setCookie(c, "g_state", state, cookieOpts);
	const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	u.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
	u.searchParams.set("redirect_uri", `${new URL(c.req.url).origin}/auth/google/callback`);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", "openid email");
	u.searchParams.set("state", state);
	u.searchParams.set("prompt", "select_account");
	return c.redirect(u.toString());
});

auth.get("/auth/google/callback", async (c) => {
	const { code, state } = c.req.query();
	if (!code || !state || state !== getCookie(c, "g_state")) return c.html(page("Login failed (invalid state)."), 400);
	deleteCookie(c, "g_state", { path: "/" });

	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code, grant_type: "authorization_code",
			client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET,
			redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`,
		}),
	});
	const tok = (await res.json()) as { id_token?: string };
	if (!res.ok || !tok.id_token) return c.html(page("Google login failed."), 502);

	let email: string;
	try {
		const { payload } = await jwtVerify(tok.id_token, GOOGLE_JWKS, {
			issuer: ["https://accounts.google.com", "accounts.google.com"],
			audience: c.env.GOOGLE_CLIENT_ID,
		});
		if (payload.email_verified !== true) throw new Error("unverified");
		email = String(payload.email).toLowerCase();
	} catch {
		return c.html(page("Could not verify your Google account."), 403);
	}

	const role = await roleFor(c.env, email);
	if (!role) return c.html(page(`${email} does not have access.`), 403);

	setCookie(c, SESSION_COOKIE, await startSession(c.env, { email, role }), { ...cookieOpts, maxAge: 7 * 86400 });
	// An admin goes straight to Zoho sign-in until their own Zoho mailbox is connected.
	const admin = adminForGoogle(c.env, email);
	if (admin && !(await isZohoConnected(c.env, admin.mailbox))) return c.redirect("/auth/zoho");
	return c.redirect("/");
});

auth.get("/auth/logout", (c) => {
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.redirect("/auth/login");
});

// -- Zoho connect (admin only) --------------------------------------

/** The logged-in admin and the Zoho mailbox that belongs to them, or null. */
async function adminOnly(c: any): Promise<{ session: Session; mailbox: string } | null> {
	const s = await readSession(c.env, getCookie(c, SESSION_COOKIE));
	const admin = s?.role === "admin" ? adminForGoogle(c.env, s.email) : undefined;
	return s && admin ? { session: s, mailbox: admin.mailbox } : null;
}

auth.get("/auth/zoho", async (c) => {
	if (!(await adminOnly(c))) return c.redirect("/auth/login");
	const state = crypto.randomUUID();
	setCookie(c, "z_state", state, cookieOpts);
	return c.redirect(zohoAuthUrl(c.env, `${new URL(c.req.url).origin}/auth/zoho/callback`, state));
});

auth.get("/auth/zoho/callback", async (c) => {
	const admin = await adminOnly(c);
	if (!admin) return c.redirect("/auth/login");
	const { code, state } = c.req.query();
	if (!code || !state || state !== getCookie(c, "z_state")) return c.html(page("Zoho connect failed (invalid state)."), 400);
	deleteCookie(c, "z_state", { path: "/" });
	try {
		await connectWithCode(c.env, admin.mailbox, code, `${new URL(c.req.url).origin}/auth/zoho/callback`);
	} catch (e) {
		const status = e instanceof ZohoError ? e.status : 500;
		return c.html(page((e as Error).message), status as 400);
	}
	c.executionCtx.waitUntil(syncZoho(c.env, admin.mailbox).catch((e) => console.error("Initial sync failed:", e.message)));
	return c.redirect("/");
});
