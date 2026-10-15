// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	unreadOnly?: boolean;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	has_attachments?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async createAPIKey(input: { name: string; createdBy: string; createdRole: "admin" | "user"; scopes: string[]; expiresInDays: number }) {
		const active = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) AS total FROM api_keys WHERE revoked_at IS NULL AND expires_at > ?1`,
			new Date().toISOString(),
		)][0] as { total: number } | undefined;
		if ((active?.total ?? 0) >= 10) throw new Error("Limit reached: revoke an API key before creating another");
		const id = crypto.randomUUID();
		const random = crypto.getRandomValues(new Uint8Array(32));
		const secret = btoa(String.fromCharCode(...random)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
		const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
		const tokenHash = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
		const createdAt = new Date().toISOString();
		const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO api_keys (id, name, token_hash, created_by, created_role, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			id, input.name, tokenHash, input.createdBy.toLowerCase(), input.createdRole, JSON.stringify(input.scopes), createdAt, expiresAt,
		);
		return { id, name: input.name, token: `nak_live.${id}.${secret}`, scopes: input.scopes, createdAt, expiresAt };
	}

	async listAPIKeys() {
		const rows = [...this.ctx.storage.sql.exec(
			`SELECT id, name, created_by, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC`,
		)] as { id: string; name: string; created_by: string; scopes: string; created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null }[];
		return rows.map((row) => ({ ...row, scopes: JSON.parse(row.scopes) as string[] }));
	}

	async revokeAPIKey(id: string) {
		this.ctx.storage.sql.exec(`UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`, new Date().toISOString(), id);
		return true;
	}

	async verifyAPIKey(id: string, secret: string, requiredScope: string) {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT token_hash, created_by, created_role, scopes, expires_at, revoked_at FROM api_keys WHERE id = ?1 LIMIT 1`, id,
		)][0] as { token_hash: string; created_by: string; created_role: "admin" | "user"; scopes: string; expires_at: string; revoked_at: string | null } | undefined;
		if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null;
		const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
		const tokenHash = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
		if (tokenHash !== row.token_hash) return null;
		const scopes = JSON.parse(row.scopes) as string[];
		if (!scopes.includes(requiredScope)) return null;
		// Legacy user-created send keys must not retain permission to send mail.
		if (requiredScope === "mail:send" && row.created_role !== "admin") return null;
		this.ctx.storage.sql.exec(`UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2`, new Date().toISOString(), id);
		return { email: row.created_by, role: row.created_role, scopes };
	}

	async createSharedDraft(input: { name: string; to?: string; cc?: string; bcc?: string; subject?: string; body: string; createdBy: string }) {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO shared_drafts (id, name, to_address, cc, bcc, subject, body, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
			id, input.name, input.to ?? "", input.cc ?? "", input.bcc ?? "", input.subject ?? "", input.body, input.createdBy.toLowerCase(), now,
		);
		return { id, ...input, createdBy: input.createdBy.toLowerCase(), createdAt: now, updatedAt: now };
	}

	async listSharedDrafts() {
		return [...this.ctx.storage.sql.exec(
			`SELECT id, name, to_address AS "to", cc, bcc, subject, body, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM shared_drafts ORDER BY updated_at DESC`,
		)];
	}

	async deleteSharedDraft(id: string) {
		this.ctx.storage.sql.exec(`DELETE FROM shared_drafts WHERE id = ?1`, id);
		return true;
	}

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	/** Recent emails (inbox/sent/archive) with a short snippet, for lead scoring. */
	async getScoringRows(limit = 800) {
		const n = Math.min(Math.max(limit, 1), 2000);
		const rows = [...this.ctx.storage.sql.exec(
			`SELECT id, COALESCE(thread_id, id) AS thread_id, folder_id, subject, sender, recipient, cc, date, read, starred,
				SUBSTR(body, 1, 600) AS snippet
			FROM emails WHERE folder_id IN ('inbox', 'sent', 'archive') ORDER BY date DESC LIMIT ?1`,
			n,
		)] as any[];
		return rows.map((r) => ({ ...r, read: !!r.read, starred: !!r.starred }));
	}

	/** Recent inbox mail (with enough body text to spot bounces and opt-outs), for the automation engine. */
	async getInboundSince(sinceIso: string, limit = 500) {
		return [...this.ctx.storage.sql.exec(
			`SELECT sender, subject, SUBSTR(body, 1, 1500) AS body, date FROM emails WHERE folder_id = 'inbox' AND date >= ?1 ORDER BY date DESC LIMIT ?2`,
			sinceIso, Math.min(Math.max(limit, 1), 1000),
		)] as { sender: string; subject: string; body: string; date: string }[];
	}

	/** (folder, date) pairs for inbox and sent since a timestamp, for send/receive counts. */
	async getActivityRows(sinceIso: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT folder_id, date FROM emails WHERE folder_id IN ('inbox', 'sent') AND date >= ?1`,
			sinceIso,
		)] as { folder_id: string; date: string }[];
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
			unreadOnly = false,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1 AND (?4 = 0 OR ds.thread_unread_count > 0)
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset, unreadOnly ? 1 : 0
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1 AND (
				?4 = 0 OR EXISTS (
					SELECT 1
					FROM folder_emails unread_fe
					LEFT JOIN thread_to_conversation unread_tc
						ON unread_fe.raw_thread_id = unread_tc.raw_thread_id
					WHERE COALESCE(unread_tc.conversation_id, unread_fe.raw_thread_id) = lif.conversation_id
						AND unread_fe.read = 0
				)
			)
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset, unreadOnly ? 1 : 0
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string, unreadOnly = false) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
					 	AND (?2 = 0 OR read = 0)`,
					folder, unreadOnly ? 1 : 0,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
						read,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT ttc.conversation_id) as total
				FROM thread_to_conversation ttc
				JOIN folder_emails fe ON fe.raw_thread_id = ttc.raw_thread_id
				WHERE ?2 = 0 OR fe.read = 0`,
				folder, unreadOnly ? 1 : 0,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			has_attachments: !!email.has_attachments,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			has_attachments: !!email.has_attachments,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	async setZohoFolderLocation(localFolderId: string, zohoFolderId: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO zoho_folder_locations (local_folder_id, zoho_folder_id) VALUES (?1, ?2)
			 ON CONFLICT(local_folder_id) DO UPDATE SET zoho_folder_id = excluded.zoho_folder_id`,
			localFolderId, zohoFolderId,
		);
		this.ctx.storage.sql.exec(`UPDATE folders SET is_deletable = 0 WHERE id = ?1`, localFolderId);
	}

	async getZohoFolderLocation(localFolderId: string): Promise<string | null> {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT zoho_folder_id FROM zoho_folder_locations WHERE local_folder_id = ?1 LIMIT 1`, localFolderId,
		)][0] as { zoho_folder_id: string } | undefined;
		return row?.zoho_folder_id ?? null;
	}

	async recordZohoMessage(emailId: string, account: string, folderId: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO zoho_message_locations (email_id, account, folder_id) VALUES (?1, ?2, ?3)
			 ON CONFLICT(email_id) DO UPDATE SET account = excluded.account, folder_id = excluded.folder_id
			 WHERE zoho_message_locations.local_override = 0`,
			emailId, account.toLowerCase(), folderId,
		);
	}

	async setZohoMessageLocation(emailId: string, account: string, folderId: string, localOverride: boolean) {
		this.ctx.storage.sql.exec(
			`INSERT INTO zoho_message_locations (email_id, account, folder_id, local_override) VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(email_id) DO UPDATE SET account = excluded.account, folder_id = excluded.folder_id, local_override = excluded.local_override`,
			emailId, account.toLowerCase(), folderId, localOverride ? 1 : 0,
		);
	}

	async getZohoMessageLocation(emailId: string): Promise<{ account: string; folder_id: string; local_override: boolean; attachment_info_checked: boolean } | null> {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT account, folder_id, local_override, attachment_info_checked FROM zoho_message_locations WHERE email_id = ?1 LIMIT 1`, emailId,
		)][0] as { account: string; folder_id: string; local_override: number; attachment_info_checked: number } | undefined;
		return row ? { ...row, local_override: !!row.local_override, attachment_info_checked: !!row.attachment_info_checked } : null;
	}

	async markZohoAttachmentInfoChecked(emailId: string, hasAttachments: boolean) {
		this.ctx.storage.sql.exec(`UPDATE zoho_message_locations SET attachment_info_checked = 1 WHERE email_id = ?1`, emailId);
		this.ctx.storage.sql.exec(`UPDATE emails SET has_attachments = ?1 WHERE id = ?2`, hasAttachments ? 1 : 0, emailId);
	}

	async storeZohoAttachments(emailId: string, items: { id: string; filename: string; size: number; content_id?: string | null; disposition: string }[]) {
		for (const item of items.slice(0, 50)) {
			if (!/^[A-Za-z0-9_-]{1,200}$/.test(item.id)) continue;
			const filename = item.filename.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 255) || "attachment";
			const size = Number.isFinite(item.size) ? Math.max(0, Math.min(Math.trunc(item.size), 100 * 1024 * 1024)) : 0;
			const ext = filename.toLowerCase().split(".").pop();
			const mimetype = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream";
			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
				item.id, emailId, filename, mimetype, size, item.content_id ?? null, item.disposition === "inline" ? "inline" : "attachment",
			);
		}
	}

	async findEmailFolder(emailId: string): Promise<string | null> {
		const row = this.db.select({ folder_id: schema.emails.folder_id }).from(schema.emails)
			.where(eq(schema.emails.id, emailId)).get();
		return row?.folder_id ?? null;
	}

	async purgeMailboxData(): Promise<string[]> {
		const emailIds = [...this.ctx.storage.sql.exec(`SELECT id FROM emails`)]
			.map((row) => String((row as { id: string }).id));
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(`DELETE FROM attachments`);
			this.ctx.storage.sql.exec(`DELETE FROM emails`);
			this.ctx.storage.sql.exec(`DELETE FROM shared_drafts`);
			this.ctx.storage.sql.exec(`DELETE FROM api_keys`);
			this.ctx.storage.sql.exec(`DELETE FROM zoho_message_locations`);
			this.ctx.storage.sql.exec(`DELETE FROM zoho_folder_locations`);
			this.ctx.storage.sql.exec(`DELETE FROM folders WHERE id NOT IN ('inbox', 'sent', 'trash', 'archive', 'spam', 'draft')`);
		});
		return emailIds;
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const folder = this.db.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders).where(eq(schema.folders.id, id)).get();
		if (!folder || folder.is_deletable === 0) return null;
		try {
			return this.db
				.update(schema.folders)
				.set({ name })
				.where(eq(schema.folders.id, id))
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
		} catch (error) {
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return null;
			throw error;
		}
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}
		// Preserve messages when deleting a custom folder instead of cascading them away.
		this.db.update(schema.emails).set({ folder_id: Folders.INBOX }).where(eq(schema.emails.folder_id, id)).run();

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async saveDraft(email: EmailData, attachments: AttachmentData[]) {
		const current = this.db
			.select({ folder_id: schema.emails.folder_id })
			.from(schema.emails)
			.where(eq(schema.emails.id, email.id))
			.get();
		if (!current) return this.createEmail(Folders.DRAFT, email, attachments);
		if (current.folder_id !== Folders.DRAFT) throw new Error("The requested draft does not exist");

		this.ctx.storage.transactionSync(() => {
			this.db.update(schema.emails).set({
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				has_attachments: attachments.length > 0 ? 1 : 0,
			}).where(eq(schema.emails.id, email.id)).run();
			this.db.delete(schema.attachments).where(eq(schema.attachments.email_id, email.id)).run();
			if (attachments.length > 0) this.db.insert(schema.attachments).values(attachments).run();
		});
		return email.id;
	}

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				has_attachments: email.has_attachments ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}
}
