// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { AutoApproval, AutoCampaign, AutoEvent, AutoImportResult, AutoLead, AutoOverview, AutoPreview, AutoReadiness, AutoSender } from "~/types/automation";
import type { IrisChatResponse, IrisLeadData } from "~/types/iris";
import type { Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	}, opts?.timeoutMs);
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function patch<T>(url: string, body?: unknown) {
	return request<T>(url, { method: "PATCH", body: body != null ? JSON.stringify(body) : undefined });
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[] }>("/api/v1/config"),

	// Current login + admin access management
	getMe: () => get<{ email: string; role: "admin" | "user"; mailbox: string | null }>("/api/v1/me"),
	syncZoho: () => post<{ synced: number; errors: number }>("/api/v1/zoho/sync"),
	getSenders: (mailboxId: string) => get<{ senders: string[] }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/senders`),
	listAssignments: () =>
		get<{ assignments: { email: string; alias: string }[]; suggestions: string[]; mainMailbox: string }>(
			"/api/v1/admin/assignments",
		),
	addAssignment: (email: string, alias: string) =>
		post<{ email: string; alias: string; created: boolean }>("/api/v1/admin/assignments", { email, alias }),
	removeAssignment: (email: string, alias: string) =>
		del<void>(`/api/v1/admin/assignments?${new URLSearchParams({ email, alias })}`),

	// Automation (cold-mail engine)
	autoOverview: () => get<AutoOverview>("/api/v1/automation/overview"),
	autoMaster: (enabled: boolean) => post<unknown>("/api/v1/automation/master", { enabled }),
	autoSenders: () => get<{ senders: AutoSender[]; error?: string }>("/api/v1/automation/senders"),
	autoCreate: (body: Record<string, unknown>) => post<{ id: string }>("/api/v1/automation/campaigns", body),
	autoUpdate: (id: string, body: Record<string, unknown>) => patch<AutoCampaign>(`/api/v1/automation/campaigns/${id}`, body),
	autoGet: (id: string) => get<{ campaign: AutoCampaign; stats: Record<string, any>; sender: AutoSender; events: AutoEvent[] }>(`/api/v1/automation/campaigns/${id}`),
	autoReadiness: (id: string) => get<AutoReadiness>(`/api/v1/automation/campaigns/${id}/readiness`),
	autoConfirm: (id: string) => post<unknown>(`/api/v1/automation/campaigns/${id}/confirm-legit`),
	autoActivate: (id: string) => post<AutoCampaign>(`/api/v1/automation/campaigns/${id}/activate`),
	autoPause: (id: string) => post<AutoCampaign>(`/api/v1/automation/campaigns/${id}/pause`),
	autoStop: (id: string) => post<AutoCampaign>(`/api/v1/automation/campaigns/${id}/stop`),
	autoGrant: (id: string, hours: number) => post<AutoCampaign>(`/api/v1/automation/campaigns/${id}/permission`, { hours }),
	autoRevoke: (id: string) => del<AutoCampaign>(`/api/v1/automation/campaigns/${id}/permission`),
	autoImport: (id: string, body: { csv?: string; sheetUrl?: string }) => post<AutoImportResult>(`/api/v1/automation/campaigns/${id}/import`, body),
	autoLeads: (id: string, status?: string) => get<{ leads: AutoLead[]; total: number }>(`/api/v1/automation/campaigns/${id}/leads`, status ? { params: { status } } : undefined),
	autoAnalysis: (id: string) => get<{ total: number; withName: number; withCompany: number; withNotes: number; topDomains: { domain: string; count: number }[]; tip: string | null }>(`/api/v1/automation/campaigns/${id}/analysis`),
	autoPreview: (id: string) => post<{ previews: AutoPreview[] }>(`/api/v1/automation/campaigns/${id}/preview`, { count: 3 }),
	autoApprovals: (id: string) => get<AutoApproval[]>("/api/v1/automation/approvals", { params: { campaignId: id } }),
	autoApprove: (id: string, edits?: { subject?: string; body?: string }) => post<unknown>(`/api/v1/automation/messages/${id}/approve`, edits ?? {}),
	autoReject: (id: string) => post<unknown>(`/api/v1/automation/messages/${id}/reject`),
	autoSkip: (leadId: string) => post<unknown>(`/api/v1/automation/leads/${leadId}/skip`),
	autoSuppress: (email: string) => post<unknown>("/api/v1/automation/suppression", { email }),

	// iRIS assistant + stats
	irisChat: (messages: { role: "user" | "assistant"; content: string }[], leadData?: Omit<IrisLeadData, "invalid">, mailboxId?: string, automationPending?: boolean) =>
		post<IrisChatResponse>("/api/v1/iris/chat", { messages: messages.slice(-12), ...(leadData ? { leadData } : {}), ...(mailboxId ? { mailboxId } : {}), ...(automationPending ? { automationPending: true } : {}) }, { timeoutMs: 60_000 }),
	irisLoadLeadData: (body: { csv?: string; sheetUrl?: string; sourceName?: string }) =>
		post<IrisLeadData>("/api/v1/iris/lead-data", body, { timeoutMs: 30_000 }),
	irisCompose: (body: { prompt: string; tone?: string; senderName?: string; replyTo?: { subject?: string; body?: string; from?: string } }) =>
		post<{ subject: string; text: string; html: string }>("/api/v1/iris/compose", body),
	getStats: (mailboxId: string) =>
		get<{ today: { sent: number; received: number }; leads: { hot: number; warm: number } }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/stats`),
	listAPIKeys: (mailboxId: string) =>
		get<{ id: string; name: string; created_by: string; scopes: string[]; created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null }[]>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/api-keys`),
	createAPIKey: (mailboxId: string, body: { name: string; scopes: string[]; expiresInDays: number }) =>
		post<{ id: string; name: string; token: string; scopes: string[]; createdAt: string; expiresAt: string }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/api-keys`, body),
	revokeAPIKey: (mailboxId: string, keyId: string) =>
		del<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/api-keys/${encodeURIComponent(keyId)}`),
	listSharedDrafts: (mailboxId: string) =>
		get<{ id: string; name: string; to: string; cc: string; bcc: string; subject: string; body: string; createdBy: string; createdAt: string; updatedAt: string }[]>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/shared-drafts`),
	createSharedDraft: (mailboxId: string, draft: { name: string; to?: string; cc?: string; bcc?: string; subject?: string; body: string }) =>
		post<{ id: string }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/shared-drafts`, draft),
	deleteSharedDraft: (mailboxId: string, draftId: string) =>
		del<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/shared-drafts/${encodeURIComponent(draftId)}`),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
			attachments?: { id: string; filename: string; type: string; size: number; disposition: "attachment" | "inline" }[];
		},
	) => post<{ id: string; status: string; attachmentIds?: string[] }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
};

export default api;
