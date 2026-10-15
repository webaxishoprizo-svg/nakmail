// Admin accounts: each admin is a Google login paired with their OWN Zoho user mailbox.
// The FIRST admin is the "primary": the aliases (and alias mailboxes) belong to its Zoho account.
import type { Env } from "./types";

export interface AdminAccount { google: string; mailbox: string }

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function adminAccounts(env: Env): AdminAccount[] {
	let raw: unknown = (env as any).ADMINS;
	if (typeof raw === "string") {
		try { raw = JSON.parse(raw); } catch { raw = []; }
	}
	if (!Array.isArray(raw)) return [];
	return raw
		.map((a: any) => ({ google: lower(a?.google), mailbox: lower(a?.mailbox) }))
		.filter((a) => a.google.includes("@") && a.mailbox.includes("@"));
}

export function primaryMailbox(env: Env): string {
	const p = adminAccounts(env)[0];
	if (!p) throw new Error("ADMINS is not configured in wrangler.jsonc");
	return p.mailbox;
}

export const adminForGoogle = (env: Env, email: string): AdminAccount | undefined =>
	adminAccounts(env).find((a) => a.google === lower(email));

export const isAdminMailbox = (env: Env, address: string): boolean =>
	adminAccounts(env).some((a) => a.mailbox === lower(address));

export const isAdminGoogle = (env: Env, email: string): boolean => !!adminForGoogle(env, email);

/** If "true", every admin may also open the other admins' personal mailboxes. Default: private. */
export const adminsShareMailboxes = (env: Env): boolean =>
	lower((env as any).ADMINS_SHARE_MAILBOXES) === "true";

/** Which connected Zoho account sends a message: an admin's own address -> that admin; anything else (aliases) -> primary. */
export function accountForSender(env: Env, from: string): string {
	const f = lower(from);
	return adminAccounts(env).find((a) => a.mailbox === f)?.mailbox ?? primaryMailbox(env);
}
