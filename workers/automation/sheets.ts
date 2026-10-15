const MAX_SHEET_BYTES = 1_500_000;

function isGoogleSheetHost(hostname: string): boolean {
	return hostname === "docs.google.com" || hostname === "googleusercontent.com" || hostname.endsWith(".googleusercontent.com");
}

export function sheetCsvUrl(input: string): string | null {
	let url: URL;
	try { url = new URL(input); } catch { return null; }
	if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.username || url.password) return null;
	const id = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1];
	if (!id) return null;
	const gid = (url.hash + url.search).match(/gid=(\d+)/)?.[1];
	return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

export async function fetchSheetCsv(input: string): Promise<string> {
	const initialUrl = sheetCsvUrl(input);
	if (!initialUrl) throw new Error("Google Sheets: paste a valid https://docs.google.com/spreadsheets link");
	let current: string = initialUrl;

	let response: Response | undefined;
	for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
		response = await fetch(current, {
			redirect: "manual",
			headers: { Accept: "text/csv" },
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status < 300 || response.status >= 400) break;
		const location = response.headers.get("location");
		if (!location || redirectCount === 3) {
			await response.body?.cancel();
			throw new Error("Google Sheets returned an invalid redirect");
		}
		const next = new URL(location, current);
		if (next.protocol !== "https:" || !isGoogleSheetHost(next.hostname) || next.username || next.password) {
			await response.body?.cancel();
			throw new Error("Google Sheets redirected to an untrusted address");
		}
		await response.body?.cancel();
		current = next.toString();
	}

	if (!response || !response.ok) {
		if (response?.body) await response.body.cancel();
		throw new Error('Could not read the sheet. Set sharing to "Anyone with the link can view" and try again.');
	}
	const finalUrl = response.url ? new URL(response.url) : new URL(current);
	if (finalUrl.protocol !== "https:" || !isGoogleSheetHost(finalUrl.hostname)) {
		await response.body?.cancel();
		throw new Error("Google Sheets redirected to an untrusted address");
	}
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > MAX_SHEET_BYTES) {
		await response.body?.cancel();
		throw new Error("The sheet is too large (limit about 1.5 MB)");
	}
	if (!response.body) throw new Error("Google Sheets returned an empty response");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		size += value.byteLength;
		if (size > MAX_SHEET_BYTES) {
			await reader.cancel();
			throw new Error("The sheet is too large (limit about 1.5 MB)");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	const csv = new TextDecoder().decode(bytes);
	if (!csv.trim() || /^\s*<!doctype html|<html/i.test(csv.slice(0, 200))) {
		throw new Error('Could not read the sheet. Set sharing to "Anyone with the link can view" and try again.');
	}
	return csv;
}
