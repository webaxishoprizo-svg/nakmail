// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "./types";
import { accountForSender } from "./config";
import { sendMessage } from "./zoho/client";

/**
 * Email sending via the Zoho Mail API.
 *
 */

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const addr = (v: string | { email: string; name: string }) => (typeof v === "string" ? v : v.email);

/** Send through Zoho: an admin's own address uses that admin's account, aliases use the primary account. */
export async function sendEmail(env: Env, params: SendEmailParams): Promise<{ providerMessageId?: string; mailId?: string; account: string }> {
	const from = addr(params.from);
	const account = accountForSender(env, from);
	const sent = await sendMessage(env, account, {
		from,
		to: list(params.to),
		cc: list(params.cc),
		bcc: list(params.bcc),
		subject: params.subject,
		html: params.html,
		text: params.text,
		attachments: params.attachments?.map((a) => ({ content: a.content, filename: a.filename, type: a.type })),
	});
	return { providerMessageId: sent.messageId, mailId: sent.mailId, account };
}
