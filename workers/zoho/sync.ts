// Pulls mail from Zoho and files it into mailboxes:
//   - the main mailbox (admin) always receives everything;
//   - each assigned alias has its OWN mailbox that only receives mail addressed to / sent from it.
import { Folders } from "../../shared/folders";
import { allAliases } from "../access/store";
import { adminAccounts, primaryMailbox } from "../config";
import { getMailboxStub } from "../lib/email-helpers";
import type { Env } from "../types";
import { getMessageContent, listFolders, listMessages, type ZohoFolder, type ZohoMessage } from "./client";
import { isZohoConnected } from "./store";
import { decodeEntities, extractAddresses, isLocalSentDuplicate, matchesAlias, matchingAliases } from "./matching";
import { configStore } from "../lib/config-store";

// Workers Free: 50 external subrequests per invocation. Each new message costs one content fetch.
const MAX_NEW_PER_RUN = 8; // per Zoho account per run
const MAX_FOLDERS_PER_RUN = 10; // leave room under Workers Free's external subrequest limit
const LIST_SIZE = 100; // newest messages looked at per Zoho folder
const KNOWN_PAGES = 3; // 3 x 100 local emails per folder are checked for duplicates
const BACKFILL_MAX = 100;

type Stub = ReturnType<typeof getMailboxStub>;
interface Known { ids: Set<string>; items: { id: string; subject: string; date: string }[] }

function resolveFolder(folder: ZohoFolder): { id: string; name: string } {
	const name = folder.folderName?.trim() || `Zoho folder ${folder.folderId}`;
	const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	const known: [string[], string, string][] = [
		[["inbox"], Folders.INBOX, "Inbox"],
		[["sent", "sentmail", "sentitems"], Folders.SENT, "Sent"],
		[["draft", "drafts"], Folders.DRAFT, "Drafts"],
		[["template", "templates"], Folders.TEMPLATES, "Templates"],
		[["snoozed"], Folders.SNOOZED, "Snoozed"],
		[["spam"], Folders.SPAM, "Spam"],
		[["junk"], Folders.SPAM, "Spam"],
		[["trash"], Folders.TRASH, "Trash"],
		[["deleteditems"], Folders.TRASH, "Trash"],
		[["outbox"], Folders.OUTBOX, "Outbox"],
		[["notification", "notifications"], Folders.NOTIFICATION, "Notification"],
		[["newsletter", "newsletters"], Folders.NEWSLETTER, "Newsletter"],
		[["archive"], Folders.ARCHIVE, "Archive"],
	];
	for (const [names, id, displayName] of known) {
		if (names.includes(normalizedName)) return { id, name: displayName };
	}
	// Zoho reports folderType="Inbox" for ordinary user-created folders too. Use
	// folderType only when the provider omitted a usable folder name.
	if (!folder.folderName?.trim()) {
		const type = String(folder.folderType ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
		for (const [names, id, displayName] of known) if (names.includes(type)) return { id, name: displayName };
	}
	const safeFolderId = String(folder.folderId || name).replace(/[^a-z\d_-]/gi, "-");
	return { id: `zoho-${safeFolderId}`, name };
}

async function ensureZohoFolder(stub: Stub, knownFolders: Map<string, { id: string; name: string }>, folder: { id: string; name: string }): Promise<string> {
	const byId = knownFolders.get(folder.id.toLowerCase());
	if (byId) return byId.id;
	const byName = [...knownFolders.values()].find((candidate) => candidate.name.toLowerCase() === folder.name.toLowerCase());
	if (byName) return byName.id;
	const created = await stub.createFolder(folder.id, folder.name, 0);
	if (created) {
		knownFolders.set(folder.id.toLowerCase(), { id: created.id, name: created.name });
		return created.id;
	}
	// A user-created local folder may already have this name. Reuse that row so mail
	// remains queryable even though the local folders table enforces unique names.
	const refreshed = (await stub.getFolders()) as { id: string; name: string }[];
	for (const existing of refreshed) knownFolders.set(existing.id.toLowerCase(), existing);
	const match = refreshed.find((candidate) => candidate.id.toLowerCase() === folder.id.toLowerCase() || candidate.name.toLowerCase() === folder.name.toLowerCase());
	if (!match) throw new Error(`Could not create local folder ${folder.name}`);
	return match.id;
}

function firstAddress(s?: string): string {
	return [...extractAddresses(s)][0] ?? "";
}

function toLocal(m: ZohoMessage, html: string) {
	const ms = Number(m.receivedTime ?? m.sentDateInGMT);
	return {
		id: `z-${m.messageId}`,
		subject: decodeEntities(m.subject ?? ""),
		sender: firstAddress(m.fromAddress ?? m.sender),
		recipient: decodeEntities(m.toAddress ?? "").toLowerCase(),
		cc: m.ccAddress && m.ccAddress !== "Not Provided" ? decodeEntities(m.ccAddress).toLowerCase() : null,
		date: new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString(),
		body: html,
		has_attachments: m.hasAttachment === true || m.hasAttachment === "1" || m.hasAttachment === "true",
		read: m.status === "1",
		thread_id: m.threadId ? `z-t-${m.threadId}` : `z-${m.messageId}`,
	};
}

export async function ensureMailbox(env: Env, address: string): Promise<string> {
	const mailbox = address.trim().toLowerCase();
	const key = `mailboxes/${mailbox}.json`;
	await configStore(env).putValueIfAbsent(key, JSON.stringify({
			fromName: mailbox, forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" },
		}));
	return mailbox;
}

async function loadKnown(stub: Stub, folder: string): Promise<Known> {
	const ids = new Set<string>();
	const items: Known["items"] = [];
	for (let page = 1; page <= KNOWN_PAGES; page++) {
		const rows = (await stub.getEmails({ folder, page, limit: 100 })) as any[];
		for (const r of rows) { ids.add(r.id); items.push({ id: r.id, subject: r.subject, date: r.date }); }
		if (rows.length < 100) break;
	}
	return { ids, items };
}

/** Insert an email; a duplicate id (parallel runs) counts as success. */
async function insertOnce(stub: Stub, folder: string, data: any, known: Known): Promise<boolean> {
	try {
		await stub.createEmail(folder, data, []);
		known.ids.add(data.id);
		return true;
	} catch (e) {
		if (/UNIQUE|constraint/i.test((e as Error).message)) { known.ids.add(data.id); return false; }
		throw e;
	}
}

/**
 * Sync every connected admin Zoho account into that admin's own mailbox.
 * Only the primary account also fans mail out to alias mailboxes (aliases belong to it).
 * With `onlyAccount`, errors are thrown to the caller; otherwise one failing account never blocks the rest.
 */
export async function syncZoho(env: Env, onlyAccount?: string): Promise<{ synced: number; errors: number }> {
	const primary = primaryMailbox(env);
	const wanted = onlyAccount?.trim().toLowerCase();
	let synced = 0, errors = 0;
	for (const acct of adminAccounts(env)) {
		if (wanted && acct.mailbox !== wanted) continue;
		if (!(await isZohoConnected(env, acct.mailbox))) continue;
		try {
			const r = await syncAccount(env, acct.mailbox, acct.mailbox === primary);
			synced += r.synced; errors += r.errors;
			if (acct.mailbox === primary) await configStore(env).putValue("automation/last_sync.json", JSON.stringify({ at: Date.now() }));
		} catch (e) {
			if (wanted) throw e;
			errors++;
			console.error(`Zoho sync failed for ${acct.mailbox}:`, (e as Error).message);
		}
	}
	return { synced, errors };
}

async function syncAccount(env: Env, account: string, isPrimary: boolean): Promise<{ synced: number; errors: number }> {
	const main = await ensureMailbox(env, account);
	const aliases = isPrimary ? (await allAliases(env)).filter((a) => a !== main) : [];
	const stubs = new Map<string, Stub>();
	for (const t of [main, ...aliases]) {
		await ensureMailbox(env, t);
		stubs.set(t, getMailboxStub(env, t));
	}

	const knownCache = new Map<string, Known>();
	const known = async (target: string, folder: string) => {
		const k = `${target}|${folder}`;
		if (!knownCache.has(k)) knownCache.set(k, await loadKnown(stubs.get(target)!, folder));
		return knownCache.get(k)!;
	};

	let synced = 0, errors = 0, budget = MAX_NEW_PER_RUN;
	const zohoFolders = await listFolders(env, account);
	const localByMailbox = new Map<string, Map<string, string>>();
	for (const zf of zohoFolders) {
		if (!zf.folderId) continue;
		const resolved = resolveFolder(zf);
		for (const target of [main, ...aliases]) {
			const targetStub = stubs.get(target)!;
			let folderMap = localByMailbox.get(target);
			if (!folderMap) { folderMap = new Map(); localByMailbox.set(target, folderMap); }
			const rows = (await targetStub.getFolders()) as { id: string; name: string }[];
			const knownFolders = new Map(rows.map((f) => [f.id.toLowerCase(), f]));
			const localId = await ensureZohoFolder(targetStub, knownFolders, resolved);
			folderMap.set(zf.folderId, localId);
			await targetStub.setZohoFolderLocation(localId, zf.folderId);
		}
	}

	if (zohoFolders.length === 0) return { synced, errors };
	const cursorKey = `zoho/folder-cursor/${account}`;
	const savedCursor = await configStore(env).getValue(cursorKey);
	const cursorValue = Number.parseInt(savedCursor ?? "0", 10);
	const cursor = Number.isFinite(cursorValue) ? ((cursorValue % zohoFolders.length) + zohoFolders.length) % zohoFolders.length : 0;
	const orderedFolders = zohoFolders.map((_, index) => zohoFolders[(index + cursor) % zohoFolders.length]);
	const selectedFolders = orderedFolders.slice(0, MAX_FOLDERS_PER_RUN);
	const pending = new Map<string, { folder: ZohoFolder; messages: ZohoMessage[]; index: number }>();
	for (const folder of selectedFolders) {
		if (!localByMailbox.get(main)?.has(folder.folderId)) continue;
		try {
			pending.set(folder.folderId, { folder, messages: (await listMessages(env, account, folder.folderId, LIST_SIZE)).reverse(), index: 0 });
		} catch (e) {
			errors++;
			console.error(`Zoho folder fetch failed for ${folder.folderName}:`, (e as Error).message);
		}
	}

	// Take one candidate from each folder per pass so a busy Inbox cannot starve Trash,
	// Spam, Archive, or custom folders when the provider-call budget is reached.
	while (budget > 0) {
		let progressed = false;
		for (const zf of selectedFolders) {
			if (budget <= 0) break;
			const entry = pending.get(zf.folderId);
			if (!entry || entry.index >= entry.messages.length) continue;
			progressed = true;
			const m = entry.messages[entry.index++];
			const sourceFolder = localByMailbox.get(main)?.get(zf.folderId);
			if (!sourceFolder) continue;
			const base = toLocal(m, "");
			const targets = [main, ...matchingAliases(sourceFolder, { from: base.sender, to: base.recipient, cc: base.cc }, aliases)];

			const missing: { mailbox: string; folder: string }[] = [];
			for (const t of targets) {
				const folder = localByMailbox.get(t)?.get(zf.folderId);
				if (!folder) continue;
				const targetStub = stubs.get(t)!;
				const providerLocation = await targetStub.getZohoMessageLocation(base.id);
				await targetStub.recordZohoMessage(base.id, account, zf.folderId);
				if (providerLocation?.local_override) continue;
				const existingFolder = await targetStub.findEmailFolder(base.id);
				if (existingFolder) {
					if (existingFolder !== folder) await targetStub.moveEmail(base.id, folder);
					continue;
				}
				const k = await known(t, folder);
				if (k.ids.has(base.id)) continue;
				if (sourceFolder === Folders.SENT && isLocalSentDuplicate(k.items, base.subject, base.date)) continue;
				missing.push({ mailbox: t, folder });
			}
			if (missing.length === 0) continue;

			// Count attempts too, so a broken provider endpoint cannot exhaust the Worker budget.
			budget--;
			let html: string;
			try {
				html = await getMessageContent(env, account, zf.folderId, m.messageId);
			} catch (e) {
				errors++;
				console.error(`Zoho content fetch failed for ${m.messageId}:`, (e as Error).message);
				continue;
			}
			for (const { mailbox: t, folder } of missing) {
				try {
					if (await insertOnce(stubs.get(t)!, folder, { ...base, body: html }, await known(t, folder))) synced++;
					await stubs.get(t)!.recordZohoMessage(base.id, account, zf.folderId);
				} catch (e) {
					errors++;
					console.error(`Failed to store ${m.messageId} in ${t}:`, (e as Error).message);
				}
			}
		}
		if (!progressed) break;
	}
	const nextCursor = (cursor + 1) % zohoFolders.length;
	await configStore(env).putValue(cursorKey, String(nextCursor));
	return { synced, errors };
}

/** Copy existing matching mail from the primary mailbox into a freshly assigned alias mailbox. */
export async function backfillAlias(env: Env, aliasAddress: string): Promise<number> {
	const main = await ensureMailbox(env, primaryMailbox(env));
	const alias = await ensureMailbox(env, aliasAddress);
	if (alias === main) return 0;
	const mainStub = getMailboxStub(env, main);
	const aliasStub = getMailboxStub(env, alias);
	let copied = 0;

	for (const folder of [Folders.INBOX, Folders.SENT]) {
		const k = await loadKnown(aliasStub, folder);
		for (let page = 1; page <= 5 && copied < BACKFILL_MAX; page++) {
			const rows = (await mainStub.getEmails({ folder, page, limit: 100 })) as any[];
			if (rows.length === 0) break;
			for (const r of rows) {
				if (copied >= BACKFILL_MAX) break;
				if (k.ids.has(r.id)) continue;
				if (!matchesAlias(folder, { from: r.sender, to: r.recipient, cc: r.cc }, alias)) continue;
				const full = (await mainStub.getEmail(r.id)) as any;
				if (!full) continue;
				const data = {
					id: full.id, subject: full.subject, sender: full.sender, recipient: full.recipient,
					cc: full.cc, bcc: null, date: full.date, body: full.body ?? "", read: full.read, starred: false,
					in_reply_to: full.in_reply_to, email_references: full.email_references,
					thread_id: full.thread_id, message_id: full.message_id, raw_headers: full.raw_headers,
				};
				if (await insertOnce(aliasStub, folder, data, k)) copied++;
			}
			if (rows.length < 100) break;
		}
	}
	return copied;
}
