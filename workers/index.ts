// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { describeAttachments } from "./lib/attachments";
import { configStore } from "./lib/config-store";
import { recordSentMessage } from "./lib/sent-message";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
	getMailboxStub,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { mailboxAuthz, requireAdmin } from "./access/authz";
import { canSendAs, sendersFor } from "./access/senders";
import { activitySince, summarizeActivity } from "./lib/analytics";
import { loadCustomers } from "./lib/customers";
import { scoreThreads } from "./lib/scoring";
import { timezoneOf } from "./iris/facts";
import { aliasesFor } from "./access/store";
import { canAdminOpen, visibleMailboxes } from "./access/visibility";
import { allAliases } from "./access/store";
import { primaryMailbox } from "./config";
import {
	deleteMessage as deleteZohoMessage,
	getMessageAttachmentContent,
	getMessageAttachmentInfo,
	moveMessage as moveZohoMessage,
	ZohoError,
} from "./zoho/client";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email().max(254),
	name: z.string().trim().min(1).max(120),
	settings: z.object({ fromName: z.string().trim().min(1).max(120).optional() }).optional(),
});

const AttachmentsBody = z.array(z.object({
	content: z.string().max(14_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Attachment content must be base64"),
	filename: z.string().trim().min(1).max(255),
	type: z.string().trim().min(1).max(255),
	disposition: z.enum(["attachment", "inline"]).default("attachment"),
	contentId: z.string().max(255).optional(),
})).max(20).optional().superRefine((attachments, ctx) => {
	let total = 0;
	for (const [index, attachment] of (attachments ?? []).entries()) {
		const padding = attachment.content.endsWith("==") ? 2 : attachment.content.endsWith("=") ? 1 : 0;
		const bytes = Math.floor(attachment.content.length * 3 / 4) - padding;
		if (bytes > 10 * 1024 * 1024) ctx.addIssue({ code: "custom", path: [index], message: "Each attachment must be 10 MB or smaller" });
		total += bytes;
	}
	if (total > 20 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Attachments must total 20 MB or less" });
});

const DraftAttachmentsBody = z.array(z.object({
	id: z.string().uuid(),
	filename: z.string().trim().min(1).max(255),
	type: z.string().trim().min(1).max(255),
	size: z.number().int().min(0).max(10 * 1024 * 1024),
	disposition: z.enum(["attachment", "inline"]).default("attachment"),
})).max(20).optional().superRefine((attachments, ctx) => {
	const total = (attachments ?? []).reduce((sum, attachment) => sum + attachment.size, 0);
	if (total > 20 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Attachments must total 20 MB or less" });
});

const DraftBody = z.object({
	name: z.string().trim().max(80).optional(),
	visibility: z.enum(["personal", "common"]).optional(),
	to: z.string().max(2000).optional(),
	cc: z.string().max(2000).optional(),
	bcc: z.string().max(2000).optional(),
	subject: z.string().max(998).optional(),
	body: z.string().max(1_000_000),
	in_reply_to: z.string().max(998).optional(),
	thread_id: z.string().max(255).optional(),
	draft_id: z.string().uuid().optional(),
	attachments: DraftAttachmentsBody,
});

const SharedDraftBody = z.object({
	name: z.string().trim().min(1).max(80),
	to: z.string().max(2000).optional(),
	cc: z.string().max(2000).optional(),
	bcc: z.string().max(2000).optional(),
	subject: z.string().max(998).optional(),
	body: z.string().max(100_000),
});

const ApiKeyBody = z.object({
	name: z.string().trim().min(1).max(80),
	scopes: z.array(z.enum(["mail:read", "mail:draft", "mail:send"])).min(1).max(3),
	expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

const SAFE_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

async function hydrateZohoAttachments(env: Env, stub: any, email: any) {
	if (!email?.has_attachments || email.attachments?.length) return email;
	const location = await stub.getZohoMessageLocation(email.id);
	if (!location || location.attachment_info_checked) return email;
	try {
		const remoteItems = await getMessageAttachmentInfo(env, location.account, location.folder_id, email.id.slice(2));
		const items = remoteItems.map((item) => ({
			id: item.attachmentId,
			filename: item.attachmentName,
			size: item.attachmentSize,
			content_id: item.cid ?? null,
			disposition: item.inline ? "inline" : "attachment",
		}));
		await stub.storeZohoAttachments(email.id, items);
		await stub.markZohoAttachmentInfoChecked(email.id, items.length > 0);
		return await stub.getEmail(email.id);
	} catch (error) {
		console.error(`Zoho attachment info fetch failed for ${email.id}:`, (error as Error).message);
		return email;
	}
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/v1/mailboxes/:mailboxId/*", bodyLimit({ maxSize: 30 * 1024 * 1024 }));
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
// Authorization first (admin: any mailbox; user: only assigned aliases), then mailbox lookup.
app.use("/api/v1/mailboxes/:mailboxId", mailboxAuthz);
app.use("/api/v1/mailboxes/:mailboxId/*", mailboxAuthz);
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	// The mailboxes this person may open (admin: own Zoho mailbox + aliases).
	const emailAddresses = await visibleMailboxes(c.env, session);
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	let allMailboxes = await listMailboxes(c.env);
	if (session.role !== "admin") {
		const mine = new Set(await aliasesFor(c.env, session.email));
		allMailboxes = allMailboxes.filter((m) => mine.has(m.id.toLowerCase()));
	} else {
		allMailboxes = allMailboxes.filter((m) => canAdminOpen(c.env, session, m.id)); // hide other admins' mailboxes
	}
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", requireAdmin, async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = await visibleMailboxes(c.env, c.get("session"));
	if (!allowedAddresses.includes(email)) {
		return c.json({ error: "You can only create your own mailbox or an assigned alias mailbox" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	if (!(await configStore(c.env).putValueIfAbsent(key, JSON.stringify(finalSettings)))) return c.json({ error: "Mailbox already exists" }, 409);
	const stub = getMailboxStub(c.env, email);
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const value = await configStore(c.env).getValue(`mailboxes/${mailboxId}.json`);
	if (!value) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: JSON.parse(value) });
});

// -- Scoped API access ----------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/api-keys", requireAdmin, async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listAPIKeys());
});

app.post("/api/v1/mailboxes/:mailboxId/api-keys", requireAdmin, async (c: AppContext) => {
	const parsed = ApiKeyBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Provide a name, one or more scopes, and a valid expiry" }, 400);
	const session = c.get("session");
	try {
		const key = await (c.var.mailboxStub as any).createAPIKey({
			...parsed.data,
			createdBy: session.email,
			createdRole: session.role,
		});
		return c.json(key, 201);
	} catch (error) {
		return c.json({ error: (error as Error).message || "Could not create API key" }, 400);
	}
});

app.delete("/api/v1/mailboxes/:mailboxId/api-keys/:keyId", requireAdmin, async (c: AppContext) => {
	await (c.var.mailboxStub as any).revokeAPIKey(c.req.param("keyId"));
	return c.body(null, 204);
});

app.get("/api/v1/mailboxes/:mailboxId/shared-drafts", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listSharedDrafts());
});

app.post("/api/v1/mailboxes/:mailboxId/shared-drafts", async (c: AppContext) => {
	const parsed = SharedDraftBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Provide a name and valid draft fields" }, 400);
	const session = c.get("session");
	const draft = await (c.var.mailboxStub as any).createSharedDraft({ ...parsed.data, createdBy: session.email });
	return c.json(draft, 201);
});

app.delete("/api/v1/mailboxes/:mailboxId/shared-drafts/:draftId", async (c: AppContext) => {
	await (c.var.mailboxStub as any).deleteSharedDraft(c.req.param("draftId"));
	return c.body(null, 204);
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const parsed = z.object({ settings: z.object({ fromName: z.string().trim().min(1).max(120) }).passthrough() }).safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "A display name of 1 to 120 characters is required" }, 400);
	const key = `mailboxes/${mailboxId}.json`;
	const current = await configStore(c.env).getValue(key);
	if (!current) return c.json({ error: "Not found" }, 404);
	const settings = { ...(JSON.parse(current) as Record<string, unknown>), fromName: parsed.data.settings.fromName };
	await configStore(c.env).putValue(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", requireAdmin, async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await configStore(c.env).hasValue(key))) return c.json({ error: "Not found" }, 404);
	const stub = c.var.mailboxStub as any;
	await stub.purgeMailboxData();
	await configStore(c.env).deleteValue(key);
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const unreadOnly = boolQuery(c, "unread");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	// Virtual folders: "hot" / "warm" are scored views over the mailbox's threads.
	if (folder === "hot" || folder === "warm") {
		const scored = scoreThreads(await (stub as any).getScoringRows(800), {
			mailbox: c.req.param("mailboxId")!.toLowerCase(), now: new Date(), customers: await loadCustomers(c.env),
		}).filter((t) => t.level === folder);
		const p = Math.max(page ?? 1, 1);
		const l = Math.min(Math.max(limit ?? 25, 1), 100);
		return c.json({ emails: scored.slice((p - 1) * l, p * l), totalCount: scored.length });
	}

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit, unreadOnly });
		const totalCount = await (stub as any).countThreadedEmails(folder, unreadOnly);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		const wanted = (typeof from === "string" ? from : from.email).toLowerCase();
		const extra = wanted !== mailboxId.toLowerCase() && (await canSendAs(c.env, c.get("session"), mailboxId, wanted)) ? [wanted] : [];
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, extra));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const generated = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	let sent: Awaited<ReturnType<typeof sendEmail>>;
	try {
		sent = await sendEmail(c.env, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
		});
	} catch (e) {
		console.error("Send via Zoho failed:", (e as Error).message);
		return c.json({ error: `Could not send: ${(e as Error).message}` }, 502);
	}
	const messageId = sent.providerMessageId ? `z-${sent.providerMessageId}` : generated.messageId;
	const outgoingMessageId = sent.mailId?.replace(/^<|>$/g, "") || generated.outgoingMessageId;

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		has_attachments: !!attachments?.length,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
		}, []);
	await recordSentMessage(c.env, stub as any, messageId, sent);

	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { name, visibility, to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id, attachments } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (visibility === "common") {
		const session = c.get("session");
		const shared = await (stub as any).createSharedDraft({ name: name || subject || "Shared draft", to, cc, bcc, subject, body, createdBy: session.email });
		return c.json({ id: shared.id, status: "shared-draft", subject: subject || "", recipient: to || "", date: shared.createdAt }, 201);
	}
	const messageId = draft_id || crypto.randomUUID();
	const now = new Date().toISOString();
	const attachmentData = describeAttachments(messageId, attachments);
	await (stub as any).saveDraft({
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
		has_attachments: !!attachments?.length,
	}, attachmentData);
	return c.json({ id: messageId, status: "draft", attachmentIds: attachmentData.map((attachment) => attachment.id), subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const stub = c.var.mailboxStub as any;
	const email = await hydrateZohoAttachments(c.env, stub, await stub.getEmail(c.req.param("id")!));
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const stub = c.var.mailboxStub as any;
	const email = await stub.getEmail(id);
	if (!email) return c.json({ error: "Not found" }, 404);
	const providerLocation = await stub.getZohoMessageLocation(id);
	if (id.startsWith("z-") && !providerLocation) return c.json({ error: "Sync this mailbox before changing this Zoho message" }, 409);
	if (providerLocation && email.folder_id !== Folders.TRASH) {
		const trashFolder = await stub.getZohoFolderLocation(Folders.TRASH);
		if (!trashFolder) return c.json({ error: "Zoho Trash is not mapped yet. Sync the mailbox and try again." }, 409);
		try {
			await moveZohoMessage(c.env, providerLocation.account, id.slice(2), providerLocation.folder_id, trashFolder);
			await stub.moveEmail(id, Folders.TRASH);
			await stub.setZohoMessageLocation(id, providerLocation.account, trashFolder, false);
			return c.json({ status: "moved_to_trash" });
		} catch (e) {
			const status = e instanceof ZohoError ? e.status : 502;
			return c.json({ error: "Zoho could not move this message to Trash" }, status as 409 | 429 | 502);
		}
	}
	if (providerLocation) {
		try {
			await deleteZohoMessage(c.env, providerLocation.account, id.slice(2), providerLocation.folder_id);
		} catch (e) {
			const status = e instanceof ZohoError ? e.status : 502;
			return c.json({ error: "Zoho could not permanently delete this message" }, status as 409 | 429 | 502);
		}
		const copies = providerLocation.account === primaryMailbox(c.env)
			? [providerLocation.account, ...(await allAliases(c.env))]
			: [providerLocation.account];
		for (const mailbox of new Set(copies.map((value) => value.toLowerCase()))) {
			const targetStub = mailbox === c.req.param("mailboxId")!.toLowerCase() ? stub : getMailboxStub(c.env, mailbox) as any;
			await targetStub.deleteEmail(id);
		}
		return c.body(null, 204);
	}
	const attachments = await stub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const parsed = z.object({ folderId: z.string().trim().min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "A destination folder is required" }, 400);
	const id = c.req.param("id")!;
	const { folderId } = parsed.data;
	const stub = c.var.mailboxStub as any;
	const providerLocation = await stub.getZohoMessageLocation(id);
	if (id.startsWith("z-") && !providerLocation) return c.json({ error: "Sync this mailbox before moving this Zoho message" }, 409);
	const destinationZohoFolder = await stub.getZohoFolderLocation(folderId);
	if (providerLocation && destinationZohoFolder) {
		try {
			await moveZohoMessage(c.env, providerLocation.account, id.slice(2), providerLocation.folder_id, destinationZohoFolder);
		} catch (e) {
			const status = e instanceof ZohoError ? e.status : 502;
			return c.json({ error: "Zoho could not move this message" }, status as 409 | 429 | 502);
		}
	}
	const success = await stub.moveEmail(id, folderId);
	if (success && providerLocation) {
		await stub.setZohoMessageLocation(id, providerLocation.account, destinationZohoFolder ?? providerLocation.folder_id, !destinationZohoFolder);
	}
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	const stub = c.var.mailboxStub as any;
	const emails = await stub.getThreadEmails(c.req.param("threadId")!);
	return c.json(await Promise.all(emails.map((email: any) => hydrateZohoAttachments(c.env, stub, email))));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Folder names must be 1 to 80 characters" }, 400);
	const { name } = parsed.data;
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Folder names must be 1 to 80 characters" }, 400);
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, parsed.data.name);
	return f ? c.json(f) : c.json({ error: "Folder not found, protected, or already using that name" }, 400);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const stub = c.var.mailboxStub as any;
	const attachment = await stub.getAttachment(attachmentId);
	if (!attachment || attachment.email_id !== emailId) return c.json({ error: "Attachment not found" }, 404);
	const providerLocation = emailId.startsWith("z-") ? await stub.getZohoMessageLocation(emailId) : null;
	if (providerLocation) {
		try {
			const remote = await getMessageAttachmentContent(c.env, providerLocation.account, providerLocation.folder_id, emailId.slice(2), attachmentId);
			const headers = new Headers();
			headers.set("Content-Type", attachment.mimetype);
			headers.set("X-Content-Type-Options", "nosniff");
			headers.set("Cache-Control", "private, no-store");
			const safeFilename = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
			const inline = SAFE_INLINE_IMAGE_TYPES.has(String(attachment.mimetype).toLowerCase());
			headers.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
			if (inline) headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
			return new Response(remote.body, { headers });
		} catch (error) {
			const status = error instanceof ZohoError ? error.status : 502;
			return c.json({ error: "Zoho could not download this attachment" }, status as 409 | 429 | 502);
		}
	}
	return c.json({ error: "This file is only available in the browser where the draft was created" }, 410);
});

// -- Stats (send/receive counts + hot/warm lead counts) --------------

app.get("/api/v1/mailboxes/:mailboxId/stats", async (c) => {
	const now = new Date();
	const stub = c.var.mailboxStub;
	const activity = summarizeActivity(await (stub as any).getActivityRows(activitySince(now)), timezoneOf(c.env), now);
	const scored = scoreThreads(await (stub as any).getScoringRows(800), {
		mailbox: c.req.param("mailboxId")!.toLowerCase(), now, customers: await loadCustomers(c.env),
	});
	return c.json({ ...activity, leads: { hot: scored.filter((t) => t.level === "hot").length, warm: scored.filter((t) => t.level === "warm").length } });
});

// -- Senders ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/senders", async (c) =>
	c.json({ senders: await sendersFor(c.env, c.get("session"), c.req.param("mailboxId")!) }));

export { app };
