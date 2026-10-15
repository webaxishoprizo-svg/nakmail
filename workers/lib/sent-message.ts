import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { getMessageAttachmentInfo, listFolders } from "../zoho/client";

type SentStub = {
	getZohoFolderLocation: (localFolderId: string) => Promise<string | null>;
	setZohoFolderLocation: (localFolderId: string, zohoFolderId: string) => Promise<void>;
	recordZohoMessage: (emailId: string, account: string, folderId: string) => Promise<void>;
	storeZohoAttachments: (emailId: string, items: { id: string; filename: string; size: number; content_id?: string | null; disposition: string }[]) => Promise<void>;
	markZohoAttachmentInfoChecked: (emailId: string, hasAttachments: boolean) => Promise<void>;
};

/** Link a newly sent local record to Zoho so its attachment bytes can be streamed from the provider. */
export async function recordSentMessage(
	env: Env,
	stub: SentStub,
	emailId: string,
	sent: { providerMessageId?: string; account: string },
): Promise<void> {
	if (!sent.providerMessageId) return;
	try {
		let folderId = await stub.getZohoFolderLocation(Folders.SENT);
		if (!folderId) {
			const folders = await listFolders(env, sent.account);
			const sentFolder = folders.find((folder) => ["sent", "sentmail", "sentitems"].includes(folder.folderName?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""));
			if (!sentFolder?.folderId) return;
			folderId = sentFolder.folderId;
			await stub.setZohoFolderLocation(Folders.SENT, folderId);
		}
		await stub.recordZohoMessage(emailId, sent.account, folderId);
		const items = await getMessageAttachmentInfo(env, sent.account, folderId, sent.providerMessageId);
		await stub.storeZohoAttachments(emailId, items.map((item) => ({
			id: item.attachmentId,
			filename: item.attachmentName,
			size: item.attachmentSize,
			content_id: item.cid ?? null,
			disposition: item.inline ? "inline" : "attachment",
		})));
		await stub.markZohoAttachmentInfoChecked(emailId, items.length > 0);
	} catch (error) {
		// Sending has already succeeded. Sync can recover this provider link later.
		console.error(`Sent message ${emailId} was not linked to Zoho:`, (error as Error).message);
	}
}
