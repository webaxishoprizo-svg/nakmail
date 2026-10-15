import type { ComposeAttachment } from "~/types/compose";

const DB_NAME = "nak-mail-local-drafts";
const DB_VERSION = 1;
const STORE_NAME = "attachments";

interface DraftAttachmentRecord {
	key: string;
	draftKey: string;
	id: string;
	filename: string;
	type: string;
	size: number;
	blob: Blob;
}

function draftKey(mailboxId: string, draftId: string) {
	return `${mailboxId.toLowerCase()}|${draftId}`;
}

function openDatabase(): Promise<IDBDatabase> {
	if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not support local draft attachments."));
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
				store.createIndex("draftKey", "draftKey", { unique: false });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open local draft storage."));
	});
}

function blobFromBase64(content: string, type: string): Blob {
	const binary = atob(content);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new Blob([bytes], { type });
}

export async function saveLocalDraftAttachments(mailboxId: string, draftId: string, attachments: ComposeAttachment[]): Promise<void> {
	const db = await openDatabase();
	const key = draftKey(mailboxId, draftId);
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readwrite");
		const store = transaction.objectStore(STORE_NAME);
		const oldRecords = store.index("draftKey").getAllKeys(key);
		oldRecords.onsuccess = () => {
			for (const oldKey of oldRecords.result) store.delete(oldKey);
			for (const attachment of attachments) {
				store.put({
					key: `${key}|${attachment.id}`,
					draftKey: key,
					id: attachment.id,
					filename: attachment.filename,
					type: attachment.type,
					size: attachment.size,
					blob: blobFromBase64(attachment.content, attachment.type),
				} satisfies DraftAttachmentRecord);
			}
		};
		transaction.oncomplete = () => { db.close(); resolve(); };
		transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("Could not save draft attachments in this browser.")); };
		transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Could not save draft attachments in this browser.")); };
	});
}

export async function loadLocalDraftAttachments(mailboxId: string, draftId: string): Promise<Map<string, Blob>> {
	const db = await openDatabase();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readonly");
		const request = transaction.objectStore(STORE_NAME).index("draftKey").getAll(draftKey(mailboxId, draftId));
		request.onsuccess = () => resolve(new Map((request.result as DraftAttachmentRecord[]).map((record) => [record.id, record.blob])));
		request.onerror = () => reject(request.error ?? new Error("Could not read local draft attachments."));
		transaction.oncomplete = () => db.close();
		transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("Could not read local draft attachments.")); };
	});
}

export async function deleteLocalDraftAttachments(mailboxId: string, draftId: string): Promise<void> {
	const db = await openDatabase();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readwrite");
		const store = transaction.objectStore(STORE_NAME);
		const request = store.index("draftKey").getAllKeys(draftKey(mailboxId, draftId));
		request.onsuccess = () => { for (const key of request.result) store.delete(key); };
		transaction.oncomplete = () => { db.close(); resolve(); };
		transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("Could not remove local draft attachments.")); };
		transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Could not remove local draft attachments.")); };
	});
}

export async function clearLocalMailboxDraftAttachments(mailboxId: string): Promise<void> {
	const db = await openDatabase();
	const prefix = `${mailboxId.toLowerCase()}|`;
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, "readwrite");
		const index = transaction.objectStore(STORE_NAME).index("draftKey");
		const request = index.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			cursor.delete();
			cursor.continue();
		};
		transaction.oncomplete = () => { db.close(); resolve(); };
		transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("Could not remove local mailbox drafts.")); };
		transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Could not remove local mailbox drafts.")); };
	});
}
