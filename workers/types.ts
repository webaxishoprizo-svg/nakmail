// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	// Secrets (wrangler secret put ...)
	SESSION_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	ZOHO_CLIENT_ID: string;
	ZOHO_CLIENT_SECRET: string;
	// iRIS hosted provider (optional). If unset, Workers AI is used.
	IRIS_API_URL?: string;
	// API format: "openai" (default) or "iris-chat" ({message, history} -> {reply}).
	IRIS_API_FORMAT?: string;
	IRIS_API_KEY?: string;
	IRIS_MODEL?: string;
	// ADMINS, ADMINS_SHARE_MAILBOXES and ZOHO_DC come from wrangler.jsonc vars (generated types).
}
