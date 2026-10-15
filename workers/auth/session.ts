// Session cookie helpers (signed JWT). Kept free of Cloudflare-only imports so it is unit-testable.
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../types";

export interface Session { email: string; role: "admin" | "user" }

export const SESSION_COOKIE = "session";
const secretKey = (env: Env) => new TextEncoder().encode(env.SESSION_SECRET);

export async function readSession(env: Env, cookie: string | undefined): Promise<Session | null> {
	if (!cookie || !env.SESSION_SECRET) return null;
	try {
		const { payload } = await jwtVerify(cookie, secretKey(env), { issuer: "nak-mail" });
		const role = payload.role;
		if (!payload.sub || (role !== "admin" && role !== "user")) return null;
		return { email: String(payload.sub).toLowerCase(), role };
	} catch {
		return null;
	}
}

export async function startSession(env: Env, s: Session): Promise<string> {
	return new SignJWT({ role: s.role })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(s.email.toLowerCase())
		.setIssuer("nak-mail")
		.setIssuedAt()
		.setExpirationTime("7d")
		.sign(secretKey(env));
}
