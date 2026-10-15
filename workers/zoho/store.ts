// Encrypted Zoho token storage in ConfigDO SQLite (AES-GCM, key derived from SESSION_SECRET), one row per Zoho account.
import { primaryMailbox } from "../config";
import type { Env } from "../types";
import { configStore } from "../lib/config-store";

export interface ZohoTokens {
	refresh_token: string;
	access_token: string;
	expires_at: number; // epoch ms
	account_id?: string;
}

const LEGACY_KEY = "zoho/token.enc"; // single-account version of this app
const keyFor = (account: string) => `zoho/token/${encodeURIComponent(account.trim().toLowerCase())}.enc`;

async function aesKey(env: Env): Promise<CryptoKey> {
	if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_SECRET));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (buf: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function saveTokens(env: Env, account: string, tokens: ZohoTokens): Promise<void> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(tokens));
	const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), data);
	await configStore(env).putValue(keyFor(account), `${b64(iv)}.${b64(enc)}`);
}

export async function loadTokens(env: Env, account: string): Promise<ZohoTokens | null> {
	let value = await configStore(env).getValue(keyFor(account));
	if (!value && account.trim().toLowerCase() === primaryMailbox(env)) value = await configStore(env).getValue(LEGACY_KEY);
	if (!value) return null;
	try {
		const [ivB64, dataB64] = value.split(".");
		const dec = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: unb64(ivB64) },
			await aesKey(env),
			unb64(dataB64),
		);
		return JSON.parse(new TextDecoder().decode(dec)) as ZohoTokens;
	} catch {
		return null; // wrong SESSION_SECRET or corrupted: treat as not connected
	}
}

export async function isZohoConnected(env: Env, account: string): Promise<boolean> {
	return (await loadTokens(env, account)) !== null;
}
