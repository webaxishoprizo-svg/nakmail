// In-memory fakes for ConfigDO, the mailbox Durable Object and Zoho.
export class FakeConfigNamespace {
	private readonly values = new Map<string, string>();
	private readonly stub = {
		getValue: async (key: string) => this.values.get(key) ?? null,
		hasValue: async (key: string) => this.values.has(key),
		putValue: async (key: string, value: string) => { this.values.set(key, value); },
		putValueIfAbsent: async (key: string, value: string) => {
			if (this.values.has(key)) return false;
			this.values.set(key, value);
			return true;
		},
		deleteValue: async (key: string) => this.values.delete(key),
		listKeys: async (prefix: string, limit = 1000) => [...this.values.keys()]
			.filter((key) => key.startsWith(prefix)).sort().slice(0, limit),
	};

	idFromName(name: string) { return name; }
	get(_id: string) { return this.stub; }
}

export class FakeMailbox {
	emails: any[] = [];
	folders: { id: string; name: string; is_deletable: number }[] = [
		{ id: "inbox", name: "Inbox", is_deletable: 0 }, { id: "sent", name: "Sent", is_deletable: 0 },
		{ id: "trash", name: "Trash", is_deletable: 0 }, { id: "archive", name: "Archive", is_deletable: 0 },
		{ id: "spam", name: "Spam", is_deletable: 0 }, { id: "draft", name: "Drafts", is_deletable: 0 },
	];
	zohoFolders = new Map<string, string>();
	zohoMessages = new Map<string, { account: string; folder_id: string; local_override: boolean }>();
	async getFolders() { return this.folders.map((folder) => ({ ...folder, unreadCount: 0 })); }
	async createFolder(id: string, name: string, is_deletable = 1) {
		if (this.folders.some((folder) => folder.id === id || folder.name.toLowerCase() === name.toLowerCase())) return null;
		this.folders.push({ id, name, is_deletable });
		return { id, name, unreadCount: 0 };
	}
	async setZohoFolderLocation(local: string, zoho: string) { this.zohoFolders.set(local, zoho); }
	async getZohoFolderLocation(local: string) { return this.zohoFolders.get(local) ?? null; }
	async recordZohoMessage(id: string, account: string, folder: string) {
		const current = this.zohoMessages.get(id);
		if (!current?.local_override) this.zohoMessages.set(id, { account, folder_id: folder, local_override: false });
	}
	async setZohoMessageLocation(id: string, account: string, folder: string, local_override: boolean) { this.zohoMessages.set(id, { account, folder_id: folder, local_override }); }
	async getZohoMessageLocation(id: string) { return this.zohoMessages.get(id) ?? null; }
	async findEmailFolder(id: string) { return this.emails.find((e) => e.id === id)?.folder ?? null; }
	async moveEmail(id: string, folder: string) {
		if (!this.folders.some((f) => f.id === folder)) return false;
		const email = this.emails.find((e) => e.id === id);
		if (email) { email.folder = folder; email.folder_id = folder; }
		return !!email;
	}
	async getEmails({ folder, page = 1, limit = 25 }: any) {
		const all = this.emails.filter((e) => e.folder === folder).sort((a, b) => b.date.localeCompare(a.date));
		const lim = Math.min(Math.max(limit, 1), 100);
		return all.slice((page - 1) * lim, page * lim).map(({ body, ...r }) => ({ ...r, snippet: body.slice(0, 300) }));
	}
	async getActivityRows(since: string) {
		return this.emails.filter((e) => ["inbox", "sent"].includes(e.folder) && e.date >= since).map((e) => ({ folder_id: e.folder, date: e.date }));
	}
	async getScoringRows(limit = 800) {
		return this.emails.filter((e) => ["inbox", "sent", "archive"].includes(e.folder))
			.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
			.map((e) => ({ id: e.id, thread_id: e.thread_id ?? e.id, folder_id: e.folder, subject: e.subject, sender: e.sender, recipient: e.recipient, cc: e.cc ?? null, date: e.date, read: !!e.read, starred: !!e.starred, snippet: String(e.body ?? "").slice(0, 600) }));
	}
	async getEmail(id: string) { const e = this.emails.find((x) => x.id === id); return e ? { ...e } : null; }
	async createEmail(folder: string, data: any) {
		if (this.emails.some((e) => e.id === data.id)) throw new Error("UNIQUE constraint failed: emails.id");
		this.emails.push({ ...data, folder, folder_id: folder });
	}
}

export function makeEnv(overrides: any = {}) {
	const boxes = new Map<string, FakeMailbox>();
	const env: any = {
		CONFIG: new FakeConfigNamespace(),
		DOMAINS: "nakmedia.co",
		ADMINS: [
			{ google: "nakmediaco@gmail.com", mailbox: "connect@nakmedia.co" },
			{ google: "nexusqteam@gmail.com", mailbox: "admin@nakmedia.co" },
		],
		ADMINS_SHARE_MAILBOXES: "false",
		ZOHO_DC: "in",
		SESSION_SECRET: "test-secret-test-secret-test-secret-1234",
		GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
		ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsecret",
		MAILBOX: {
			idFromName: (n: string) => n,
			get: (id: string) => { if (!boxes.has(id)) boxes.set(id, new FakeMailbox()); return boxes.get(id)!; },
		},
		...overrides,
	};
	return { env, boxes };
}

export const PRIMARY = "connect@nakmedia.co";
export const SECOND = "admin@nakmedia.co";

export interface ZohoData {
	folders?: any[]; messages?: Record<string, any[]>; addresses?: string[];
	content?: (id: string) => string; failContent?: Set<string>; failFolders?: boolean;
	attachmentInfo?: any; attachmentBytes?: string;
}

/**
 * Mock global fetch for Zoho. The first argument is the PRIMARY account's data; `others` holds
 * other accounts keyed by mailbox. The account is identified by its token: "AT-<mailbox>".
 */
export function mockZoho(primary: ZohoData, others: Record<string, ZohoData> = {}) {
	const datasets: Record<string, ZohoData> = { [PRIMARY]: primary, ...others };
	const calls: string[] = [];
	const sends: { account: string; body: any }[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: any, init?: any) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

		if (url.includes("/oauth/v2/token")) {
			const p = new URLSearchParams(String(init.body));
			if (p.get("grant_type") === "authorization_code") {
				const who = p.get("code")!.replace(/^code-/, "");
				return json({ access_token: `AT-${who}`, refresh_token: `RT-${who}`, expires_in: 3600 });
			}
			return json({ access_token: `AT-${p.get("refresh_token")!.replace(/^RT-/, "")}`, expires_in: 3600 });
		}
		const auth = new Headers(init?.headers).get("authorization") ?? "";
		const account = auth.replace("Zoho-oauthtoken AT-", "");
		const d = datasets[account];
		if (!d) return json({ error: "no dataset for " + account }, 401);

		if (/\/api\/accounts$/.test(url)) {
			return json({ data: [{ accountId: `acct-${account}`, primaryEmailAddress: account, emailAddress: (d.addresses ?? []).map((mailId) => ({ mailId })) }] });
		}
		if (/\/folders$/.test(url)) return d.failFolders ? json({ error: "down" }, 500) : json({ data: d.folders ?? [] });
		if (url.includes("/attachmentinfo")) return json({ data: d.attachmentInfo ?? { attachments: [], inline: [] } });
		if (/\/attachments\/[^/]+$/.test(url)) return new Response(d.attachmentBytes ?? "fake attachment", { headers: { "content-type": "application/octet-stream" } });
		if (url.endsWith("/updatemessage") && method === "PUT") return json({ status: { code: 200, description: "success" } });
		if (method === "DELETE" && /\/messages\/\w+(?:\?[^#]*)?$/.test(url)) return json({ status: { code: 200, description: "success" } });
		const view = url.match(/messages\/view\?.*folderId=(\d+)/);
		if (view) return json({ data: d.messages?.[view[1]] ?? [] });
		const content = url.match(/messages\/(\w+)\/content/);
		if (content) {
			if (d.failContent?.has(content[1])) return json({ error: "boom" }, 500);
			return json({ data: { content: d.content?.(content[1]) ?? `<p>body ${content[1]}</p>` } });
		}
		if (url.endsWith("/messages") && method === "POST") { sends.push({ account, body: JSON.parse(init.body) }); return json({ status: { code: 200 }, data: {} }); }
		return json({ error: "unmocked " + url }, 404);
	}) as any;
	return { calls, sends, restore: () => { globalThis.fetch = orig; } };
}

export async function seedTokens(env: any, account = PRIMARY) {
	const { saveTokens } = await import("../workers/zoho/store");
	await saveTokens(env, account, { refresh_token: `RT-${account}`, access_token: `AT-${account}`, expires_at: Date.now() + 3_600_000, account_id: `acct-${account}` });
}
