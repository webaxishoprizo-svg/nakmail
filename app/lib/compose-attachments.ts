import type { ComposeAttachment } from "~/types/compose";

export const MAX_COMPOSE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COMPOSE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_COMPOSE_FILE_COUNT = 20;

const MIME_BY_EXTENSION: Record<string, string> = {
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	csv: "text/csv",
	txt: "text/plain",
	rtf: "application/rtf",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	heic: "image/heic",
	heif: "image/heif",
	tif: "image/tiff",
	tiff: "image/tiff",
};

export const COMPOSE_ATTACHMENT_ACCEPT = Object.keys(MIME_BY_EXTENSION).map((extension) => `.${extension}`).join(",");

export function attachmentMimeType(filename: string, fallback = "application/octet-stream"): string {
	const extension = filename.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[extension] ?? fallback;
}

export function validateComposeFile(file: File, remainingBytes: number, remainingCount: number): string | null {
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	if (!MIME_BY_EXTENSION[extension]) return `${file.name}: choose a supported document or image file.`;
	if (file.size === 0) return `${file.name}: this file is empty.`;
	if (file.size > MAX_COMPOSE_FILE_BYTES) return `${file.name}: each file must be 10 MB or smaller.`;
	if (file.size > remainingBytes) return `${file.name}: attachments can total 20 MB or less.`;
	if (remainingCount <= 0) return `You can attach up to ${MAX_COMPOSE_FILE_COUNT} files.`;
	return null;
}

export async function encodeComposeBlob(blob: Blob, filename: string, fallbackType?: string): Promise<ComposeAttachment> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return {
		id: crypto.randomUUID(),
		filename,
		type: attachmentMimeType(filename, fallbackType || "application/octet-stream"),
		size: blob.size,
		content: btoa(binary),
	};
}

export async function encodeComposeFile(file: File): Promise<ComposeAttachment> {
	return encodeComposeBlob(file, file.name, file.type);
}

export async function prepareComposeFiles(files: File[], existing: ComposeAttachment[]) {
	let remainingBytes = MAX_COMPOSE_TOTAL_BYTES - existing.reduce((sum, attachment) => sum + attachment.size, 0);
	let remainingCount = MAX_COMPOSE_FILE_COUNT - existing.length;
	const accepted: ComposeAttachment[] = [];
	const errors: string[] = [];
	for (const file of files) {
		const reason = validateComposeFile(file, remainingBytes, remainingCount);
		if (reason) { errors.push(reason); continue; }
		try {
			accepted.push(await encodeComposeFile(file));
			remainingBytes -= file.size;
			remainingCount--;
		} catch {
			errors.push(`${file.name}: could not read this file.`);
		}
	}
	return { accepted, errors };
}
