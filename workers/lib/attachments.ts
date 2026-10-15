/** Attachment metadata stored with mail records; file contents remain with Zoho or the browser. */
export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

export interface DraftAttachmentInput {
	id: string;
	filename: string;
	type: string;
	size: number;
	disposition: "attachment" | "inline";
}

/** Convert client supplied draft metadata to the mailbox's attachment rows. */
export function describeAttachments(
	emailId: string,
	attachments?: DraftAttachmentInput[],
): StoredAttachment[] {
	return (attachments ?? []).map((attachment) => ({
		id: crypto.randomUUID(),
		email_id: emailId,
		filename: attachment.filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 255) || "attachment",
		mimetype: attachment.type,
		size: attachment.size,
		content_id: null,
		disposition: attachment.disposition,
	}));
}
