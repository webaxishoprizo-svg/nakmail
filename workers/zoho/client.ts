// Zoho Mail REST client. All requests use the data center in ZOHO_DC (default "in").
import type { Env } from "../types";
import { loadTokens, saveTokens, type ZohoTokens } from "./store";

export const ZOHO_SCOPES = "ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.ALL";

const dc = (env: Env) => env.ZOHO_DC || "in";
const accountsBase = (env: Env) => `https://accounts.zoho.${dc(env)}`;
const mailBase = (env: Env) => `https://mail.zoho.${dc(env)}`;

export class ZohoError extends Error {
	constructor(message: string, public status = 500) {
		super(message);
	}
}

// -- OAuth ----------------------------------------------------------

export function zohoAuthUrl(env: Env, redirectUri: string, state: string): string {
	const u = new URL(`${accountsBase(env)}/oauth/v2/auth`);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", env.ZOHO_CLIENT_ID);
	u.searchParams.set("scope", ZOHO_SCOPES);
	u.searchParams.set("redirect_uri", redirectUri);
	u.searchParams.set("access_type", "offline"); // needed to receive a refresh token
	u.searchParams.set("prompt", "consent");
	u.searchParams.set("state", state);
	return u.toString();
}

async function tokenRequest(env: Env, params: Record<string, string>) {
	const res = await fetch(`${accountsBase(env)}/oauth/v2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.ZOHO_CLIENT_ID,
			client_secret: env.ZOHO_CLIENT_SECRET,
			...params,
		}),
	});
	const json = (await res.json()) as Record<string, any>;
	if (!res.ok || json.error) throw new ZohoError(`Zoho token error: ${json.error ?? res.status}`, 502);
	return json;
}

/** Exchange the auth code, verify it belongs to `account`, then store tokens for that account only. */
export async function connectWithCode(env: Env, account: string, code: string, redirectUri: string): Promise<void> {
	const json = await tokenRequest(env, {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
	});
	if (!json.refresh_token) {
		throw new ZohoError("Zoho returned no refresh token. Revoke the app in Zoho and connect again.", 400);
	}
	const tokens: ZohoTokens = {
		refresh_token: json.refresh_token,
		access_token: json.access_token,
		expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
	};

	// Verify the authorised Zoho account is the expected mailbox before saving anything.
	const accRes = await fetch(`${mailBase(env)}/api/accounts`, {
		headers: { Authorization: `Zoho-oauthtoken ${tokens.access_token}` },
	});
	const acc = (await accRes.json()) as any;
	const accounts: any[] = Array.isArray(acc?.data) ? acc.data : [];
	const expected = account.toLowerCase();
	const match = accounts.find((a) => JSON.stringify(a).toLowerCase().includes(expected));
	if (!match) {
		throw new ZohoError(`Signed in to the wrong Zoho account. Please sign in as ${account}.`, 403);
	}
	tokens.account_id = String(match.accountId);
	await saveTokens(env, account, tokens);
}

async function refresh(env: Env, account: string, tokens: ZohoTokens): Promise<ZohoTokens> {
	const json = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
	const next: ZohoTokens = {
		...tokens,
		access_token: json.access_token,
		expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
	};
	await saveTokens(env, account, next);
	return next;
}

async function getTokens(env: Env, account: string, force = false): Promise<ZohoTokens> {
	let t = await loadTokens(env, account);
	if (!t) throw new ZohoError(`Zoho is not connected for ${account}. Sign in as its admin and open /auth/zoho.`, 409);
	if (force || t.expires_at - Date.now() < 60_000) t = await refresh(env, account, t);
	return t;
}

// -- API calls --------------------------------------------------------

async function zoho<T = any>(env: Env, account: string, path: string, init: RequestInit = {}): Promise<T> {
	const call = async (t: ZohoTokens) =>
		fetch(`${mailBase(env)}${path}`, {
			...init,
			headers: { ...(init.headers ?? {}), Authorization: `Zoho-oauthtoken ${t.access_token}` },
		});
	let res = await call(await getTokens(env, account));
	if (res.status === 401) res = await call(await getTokens(env, account, true)); // token revoked/expired early
	const text = await res.text();
	let json: any;
	try { json = JSON.parse(text); } catch { json = null; }
	if (!res.ok) {
		const msg = json?.data?.errorCode ?? json?.status?.description ?? text.slice(0, 200);
		throw new ZohoError(`Zoho API ${res.status}: ${msg}`, res.status === 429 ? 429 : 502);
	}
	if (typeof json?.status?.code === "number" && json.status.code >= 400) {
		throw new ZohoError(`Zoho API ${json.status.code}: ${json.status.description ?? "request failed"}`, json.status.code === 429 ? 429 : 502);
	}
	return json as T;
}

async function accountId(env: Env, account: string): Promise<string> {
	const t = await getTokens(env, account);
	if (t.account_id) return t.account_id;
	const r = await zoho<any>(env, account, "/api/accounts");
	const id = String(r.data?.[0]?.accountId ?? "");
	if (!id) throw new ZohoError("Could not find the Zoho account id", 502);
	await saveTokens(env, account, { ...t, account_id: id });
	return id;
}

export interface ZohoFolder { folderId: string; folderName: string; folderType?: string }
export interface ZohoMessage {
	messageId: string; folderId: string; threadId?: string; subject?: string;
	fromAddress?: string; sender?: string; toAddress?: string; ccAddress?: string;
	receivedTime?: string; sentDateInGMT?: string; status?: string; hasAttachment?: string | boolean;
}

export interface ZohoAttachmentInfo {
	attachmentId: string;
	attachmentName: string;
	attachmentSize: number;
	cid?: string;
	inline: boolean;
}

export async function listFolders(env: Env, account: string): Promise<ZohoFolder[]> {
	const id = await accountId(env, account);
	return (await zoho<any>(env, account, `/api/accounts/${encodeURIComponent(id)}/folders`)).data ?? [];
}

export async function listMessages(env: Env, account: string, folderId: string, limit = 30): Promise<ZohoMessage[]> {
	const id = await accountId(env, account);
	const q = new URLSearchParams({ folderId, start: "1", limit: String(limit), sortBy: "date", sortorder: "false" });
	return (await zoho<any>(env, account, `/api/accounts/${encodeURIComponent(id)}/messages/view?${q}`)).data ?? [];
}

export async function getMessageContent(env: Env, account: string, folderId: string, messageId: string): Promise<string> {
	const id = await accountId(env, account);
	const r = await zoho<any>(env, account, `/api/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}/content`);
	return r.data?.content ?? "";
}

/** Load attachment metadata only when the user opens a message that has attachments. */
export async function getMessageAttachmentInfo(env: Env, account: string, folderId: string, messageId: string): Promise<ZohoAttachmentInfo[]> {
	const id = await accountId(env, account);
	const path = `/api/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}/attachmentinfo?includeInline=true`;
	const data = (await zoho<any>(env, account, path)).data ?? {};
	const items: ZohoAttachmentInfo[] = [];
	for (const a of Array.isArray(data.attachments) ? data.attachments : []) {
		items.push({ attachmentId: String(a.attachmentId ?? ""), attachmentName: String(a.attachmentName ?? "attachment"), attachmentSize: Number(a.attachmentSize ?? 0), inline: false });
	}
	for (const a of Array.isArray(data.inline) ? data.inline : []) {
		items.push({ attachmentId: String(a.attachmentId ?? ""), attachmentName: String(a.attachmentName ?? "inline-image"), attachmentSize: Number(a.attachmentSize ?? 0), cid: a.cid ? String(a.cid) : undefined, inline: true });
	}
	return items.slice(0, 50);
}

/** Return Zoho's attachment stream without buffering it into Worker memory. */
export async function getMessageAttachmentContent(env: Env, account: string, folderId: string, messageId: string, attachmentId: string): Promise<Response> {
	const id = await accountId(env, account);
	const path = `/api/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
	const call = (accessToken: string) => fetch(`${mailBase(env)}${path}`, {
		headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: "application/octet-stream" },
	});
	let tokens = await getTokens(env, account);
	let response = await call(tokens.access_token);
	if (response.status === 401) {
		tokens = await getTokens(env, account, true);
		response = await call(tokens.access_token);
	}
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		throw new ZohoError(`Zoho attachment API ${response.status}: ${detail}`, response.status === 429 ? 429 : 502);
	}
	return response;
}

/** Move one message between Zoho folders; IDs are sourced from the authenticated account's folder/message APIs. */
export async function moveMessage(env: Env, account: string, messageId: string, sourceFolderId: string, destinationFolderId: string): Promise<void> {
	const id = await accountId(env, account);
	await zoho(env, account, `/api/accounts/${encodeURIComponent(id)}/updatemessage`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			mode: "moveMessage",
			messageId: [messageId],
			destfolderId: destinationFolderId,
			isFolderSpecific: true,
			folderId: sourceFolderId,
		}),
	});
}

/** Permanently delete a message from its current Zoho folder. */
export async function deleteMessage(env: Env, account: string, messageId: string, folderId: string): Promise<void> {
	const id = await accountId(env, account);
	await zoho(env, account, `/api/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}?expunge=true`, {
		method: "DELETE",
		headers: { Accept: "application/json" },
	});
}

export interface ZohoSend {
	from: string; to: string[]; cc?: string[]; bcc?: string[];
	subject: string; html?: string; text?: string;
	attachments?: { content: string; filename: string; type: string }[];
}

export async function sendMessage(env: Env, account: string, m: ZohoSend): Promise<{ messageId?: string; mailId?: string }> {
	const id = await accountId(env, account);
	const body: Record<string, unknown> = {
		fromAddress: m.from,
		toAddress: m.to.join(","),
		subject: m.subject,
		content: m.html ?? m.text ?? "",
		mailFormat: m.html ? "html" : "plaintext",
	};
	if (m.cc?.length) body.ccAddress = m.cc.join(",");
	if (m.bcc?.length) body.bccAddress = m.bcc.join(",");

	// Attachments: upload each file first, then reference it (UNTESTED against live Zoho).
	if (m.attachments?.length) {
		const refs: unknown[] = [];
		for (const a of m.attachments) {
			const bytes = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
			const form = new FormData();
			form.append("attach", new Blob([bytes], { type: a.type }), a.filename);
			const up = await zoho<any>(env, account, `/api/accounts/${id}/messages/attachments?uploadType=multipart`, {
				method: "POST",
				body: form,
			});
			if (up.data?.[0]) refs.push(up.data[0]);
		}
		body.attachments = refs;
	}

	const response = await zoho<any>(env, account, `/api/accounts/${id}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
	});
	return {
		messageId: response?.data?.messageId == null ? undefined : String(response.data.messageId),
		mailId: response?.data?.mailId == null ? undefined : String(response.data.mailId),
	};
}

/** Best-effort list of addresses (primary + aliases) on a Zoho account. Reads only Zoho's address fields. */
export async function listAccountAddresses(env: Env, account: string, domains: string[]): Promise<string[]> {
	const r = await zoho<any>(env, account, "/api/accounts");
	const found = new Set<string>();
	const add = (v: unknown) => {
		const a = String(v ?? "").trim().toLowerCase();
		if (/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(a) && domains.includes(a.split("@")[1])) found.add(a);
	};
	for (const acc of Array.isArray(r?.data) ? r.data : []) {
		add(acc?.primaryEmailAddress);
		add(acc?.mailboxAddress);
		for (const e of Array.isArray(acc?.emailAddress) ? acc.emailAddress : []) add(e?.mailId);
	}
	return [...found].sort();
}
