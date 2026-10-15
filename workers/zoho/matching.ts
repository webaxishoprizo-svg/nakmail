// Pure helpers that decide which alias mailbox(es) a message belongs to.
// Matching is by exact address (never substring): "presales@x.co" must not match "sales@x.co".

const ADDR_RE = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

export const decodeEntities = (s = ""): string =>
	s.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, "&");

/** All distinct, lowercased email addresses found in a header-like string. */
export function extractAddresses(s?: string | null): Set<string> {
	const out = new Set<string>();
	for (const m of decodeEntities(s ?? "").matchAll(ADDR_RE)) out.add(m[0].toLowerCase());
	return out;
}

export interface Routable { from?: string | null; to?: string | null; cc?: string | null }

/** Alias mailboxes receive messages related to that alias, regardless of the Zoho folder. */
export function matchesAlias(folder: string, m: Routable, alias: string): boolean {
	const a = alias.trim().toLowerCase();
	return extractAddresses(m.from).has(a) || extractAddresses(m.to).has(a) || extractAddresses(m.cc).has(a);
}

export function matchingAliases(folder: string, m: Routable, aliases: string[]): string[] {
	return aliases.filter((a) => matchesAlias(folder, m, a));
}

/** True if a locally-sent copy of this message (non Zoho id) already exists in the mailbox. */
export function isLocalSentDuplicate(
	items: { id: string; subject: string; date: string }[],
	subject: string,
	dateIso: string,
): boolean {
	const t = new Date(dateIso).getTime();
	return items.some(
		(e) => !e.id.startsWith("z-") && e.subject === subject && Math.abs(new Date(e.date).getTime() - t) < 5 * 60_000,
	);
}
