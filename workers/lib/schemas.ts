// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email().max(254),
	z.array(z.string().email().max(254)).min(1).max(50),
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const Base64AttachmentSchema = z.object({
	content: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4)
		.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Attachment content must be base64"),
	filename: z.string().trim().min(1).max(255),
	type: z.string().trim().min(1).max(255),
	disposition: z.enum(["attachment", "inline"]),
	contentId: z.string().max(255).optional(),
});

function attachmentBatchWithinLimit(attachments: { content: string }[] | undefined): boolean {
	if (!attachments) return true;
	let total = 0;
	for (const attachment of attachments) {
		const value = attachment.content;
		const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
		const bytes = Math.floor(value.length * 3 / 4) - padding;
		if (bytes > MAX_ATTACHMENT_BYTES) return false;
		total += bytes;
		if (total > MAX_TOTAL_ATTACHMENT_BYTES) return false;
	}
	return true;
}

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email().max(254),
			z.object({ email: z.string().email().max(254), name: z.string().max(120) }),
		]),
		subject: z.string().max(998),
		html: z.string().max(1_000_000).optional(),
		text: z.string().max(1_000_000).optional(),
		attachments: z.array(Base64AttachmentSchema).max(20).optional(),
		in_reply_to: z.string().max(998).optional(),
		references: z.array(z.string().max(998)).max(50).optional(),
		thread_id: z.string().max(255).optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	})
	.refine((data) => attachmentBatchWithinLimit(data.attachments), {
		message: "Attachments exceed the 10 MB per-file or 20 MB total limit",
		path: ["attachments"],
	});

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});
