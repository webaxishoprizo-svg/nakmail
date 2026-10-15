// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import { useDeleteEmail, useForwardEmail, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useSenders } from "~/queries/access";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import type { ComposeAttachment } from "~/types/compose";
import { encodeComposeBlob, prepareComposeFiles } from "~/lib/compose-attachments";
import { deleteLocalDraftAttachments, loadLocalDraftAttachments, saveLocalDraftAttachments } from "~/lib/local-draft-attachments";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

export type { ComposeAttachment } from "~/types/compose";

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			to: composeOptions.to || "",
			subject: composeOptions.subject || "",
			body: composeOptions.body ?? (sigBlock ? `<p><br></p>${sigBlock}` : ""),
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const { data: sendersData } = useSenders(mailboxId);
	const senders = sendersData?.senders ?? [];
	const [chosenFrom, setChosenFrom] = useState<string | null>(null);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const deleteEmailMutation = useDeleteEmail();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [isAddingAttachments, setIsAddingAttachments] = useState(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const currentDraftIdRef = useRef<string | undefined>(composeOptions.draftEmail?.id);
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	// Default From: when replying, the alias the message was addressed to (if you may send as it); otherwise the mailbox.
	const defaultFrom = useMemo(() => {
		const own = currentMailbox?.email;
		const orig = composeOptions.originalEmail;
		if ((composeOptions.mode === "reply" || composeOptions.mode === "reply-all") && orig) {
			const addrs = new Set(`${orig.recipient ?? ""} ${orig.cc ?? ""}`.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);
			const hit = senders.find((s) => addrs.has(s));
			if (hit) return hit;
		}
		return own;
	}, [composeOptions.mode, composeOptions.originalEmail, currentMailbox?.email, senders]);
	const fromAddress = chosenFrom && senders.includes(chosenFrom) ? chosenFrom : defaultFrom;

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;
		currentDraftIdRef.current = composeOptions.draftEmail?.id;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setChosenFrom(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
	}, [composeOptions, currentMailbox?.email, sigBlock]);

	useEffect(() => {
		let cancelled = false;
		const draft = composeOptions.draftEmail;
		setIsAddingAttachments(false);
		setAttachments(composeOptions.attachments ?? []);
		if (!mailboxId || !draft?.attachments?.length) return;
		setIsAddingAttachments(true);
		loadLocalDraftAttachments(mailboxId, draft.id).then(async (localFiles) => {
			const items = await Promise.all(draft.attachments!.map(async (attachment) => {
				const blob = localFiles.get(attachment.id);
				if (!blob) return {
					id: attachment.id,
					filename: attachment.filename,
					type: attachment.mimetype || "application/octet-stream",
					size: attachment.size,
					content: "",
				};
				return {
					...(await encodeComposeBlob(blob, attachment.filename, attachment.mimetype || blob.type || "application/octet-stream")),
					id: attachment.id,
					size: attachment.size,
				};
			}));
			if (cancelled) return;
			setAttachments(items);
			if (items.some((item) => !item.content)) setError("Some draft files are missing from this browser. Remove them and reattach the files before saving or sending.");
		}).catch(() => {
			if (cancelled) return;
			setAttachments(draft.attachments!.map((attachment) => ({
				id: attachment.id,
				filename: attachment.filename,
				type: attachment.mimetype || "application/octet-stream",
				size: attachment.size,
				content: "",
			})));
			setError("Draft files are only stored in the browser where they were added. Remove and reattach the files before saving or sending.");
		}).finally(() => { if (!cancelled) setIsAddingAttachments(false); });
		return () => { cancelled = true; };
	}, [composeOptions, mailboxId]);

	const addAttachments = async (files: File[]) => {
		if (isAddingAttachments || isSending) return;
		setIsAddingAttachments(true);
		try {
			const { accepted, errors } = await prepareComposeFiles(files, attachments);
			if (errors.length) setError(errors.slice(0, 3).join(" "));
			else if (accepted.length) setError(null);
			if (accepted.length) setAttachments((current) => [...current, ...accepted]);
		} finally {
			setIsAddingAttachments(false);
		}
	};

	const removeAttachment = (id: string) => setAttachments((current) => current.filter((item) => item.id !== id));

	const handleSaveDraft = async () => {
		if (isAddingAttachments) { setError("Wait for the attachments to finish loading."); return; }
		if (attachments.some((attachment) => !attachment.content)) { setError("Remove missing draft files and reattach them before saving."); return; }
		if (!mailboxId || isSending) return; setIsSavingDraft(true); setError(null);
		try {
			const previousDraftId = currentDraftIdRef.current;
			const savedDraft = await saveDraftMutation.mutateAsync({ mailboxId, draft: {
				to,
				cc: cc || undefined,
				bcc: bcc || undefined,
				subject,
				body,
				attachments: attachments.map(({ id, filename, type, size }) => ({ id, filename, type, size, disposition: "attachment" as const })),
				in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
				thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
				draft_id: previousDraftId,
			} });
			if (savedDraft.status === "draft") {
				const localAttachments = attachments.map((attachment, index) => ({
					...attachment,
					id: savedDraft.attachmentIds?.[index] ?? attachment.id,
				}));
				try {
					await saveLocalDraftAttachments(mailboxId, savedDraft.id, localAttachments);
				} catch (cause) {
					if (savedDraft.id !== previousDraftId) await deleteEmailMutation.mutateAsync({ mailboxId, id: savedDraft.id }).catch(() => {});
					throw new Error(`Draft attachments could not be saved in this browser: ${(cause as Error).message}`);
				}
				setAttachments(localAttachments);
				currentDraftIdRef.current = savedDraft.id;
				if (previousDraftId && previousDraftId !== savedDraft.id) {
					try { await deleteEmailMutation.mutateAsync({ mailboxId, id: previousDraftId }); }
					catch { setError("Draft saved, but its previous copy could not be removed."); }
					await deleteLocalDraftAttachments(mailboxId, previousDraftId).catch(() => {});
				}
			}
			toastManager.add({ title: "Draft saved!" });
		}
		catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsSavingDraft(false); }
	};

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault(); if (isSending) return;
		if (isAddingAttachments) { setError("Wait for the attachments to finish loading."); return; }
		if (attachments.some((attachment) => !attachment.content)) { setError("Remove missing draft files and reattach them before sending."); return; }
		setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		const toRecipients = splitEmailList(to);
		if (toRecipients.length === 0) { setError("Add at least one recipient."); return; }
		const ccRecipients = splitEmailList(cc); const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
		const fromAddr = fromAddress ?? currentMailbox.email;
		const from = fromAddr === currentMailbox.email && fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : fromAddr;
		const emailData = {
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			from,
			subject,
			html: body,
			text: htmlToPlainText(body),
			attachments: attachments.map(({ filename, type, content }) => ({ content, filename, type, disposition: "attachment" as const })),
		};
		const draftId = currentDraftIdRef.current; const mode = composeOptions.mode; const originalId = composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;
		setIsSending(true); toastManager.add({ title: "Sending email..." });
		try {
			if ((mode === "reply" || mode === "reply-all") && originalId) await replyMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else if (mode === "forward" && originalId) await forwardMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else await sendEmailMutation.mutateAsync({ mailboxId, email: emailData });
			if (draftId) deleteEmailMutation.mutate({ mailboxId, id: draftId });
			toastManager.add({ title: "Email sent!" });
			onClose();
		} catch (err: unknown) { const message = (err instanceof Error ? err.message : null) || "Failed to send email."; setError(message); toastManager.add({ title: message, variant: "error" }); }
		finally { setIsSending(false); }
	};

	const orig = composeOptions.originalEmail;
	const irisReplyTo = orig
		? { subject: orig.subject, from: orig.sender, body: htmlToPlainText(orig.body ?? orig.snippet ?? "").slice(0, 3000) }
		: undefined;
	const senderName = currentMailbox?.settings?.fromName || currentMailbox?.name;

	return { irisReplyTo, senderName, senders, fromAddress, setFromAddress: setChosenFrom, to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody, attachments, addAttachments, removeAttachment, error, setError, isSavingDraft, isSending, isAddingAttachments, formTitle, handleSaveDraft, handleSend, closeCompose, closePanel };
}
