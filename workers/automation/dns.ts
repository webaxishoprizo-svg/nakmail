// DNS checks over DNS-over-HTTPS: is the sending domain set up so mail is trusted, and can a recipient domain receive mail?
export type Doh = (name: string, type: "TXT" | "MX" | "A") => Promise<string[]>;

export const cloudflareDoh: Doh = async (name, type) => {
	const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
		headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
	const j = (await res.json()) as { Answer?: { data: string }[] };
	return (j.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
};

export interface DomainHealth { domain: string; spf: boolean; dmarc: boolean; dkim: boolean | null; errors: string[]; warnings: string[] }

export async function checkSendingDomain(domain: string, doh: Doh, dkimSelector?: string): Promise<DomainHealth> {
	const errors: string[] = [], warnings: string[] = [];
	const txt = async (n: string) => { try { return await doh(n, "TXT"); } catch { return null; } };

	const root = await txt(domain);
	const spfRec = root?.find((r) => /^v=spf1/i.test(r));
	const spf = !!spfRec && /zoho/i.test(spfRec);
	if (root === null) warnings.push("Could not look up SPF (DNS lookup failed)");
	else if (!spfRec) errors.push(`${domain} has no SPF record`);
	else if (!spf) errors.push(`SPF for ${domain} does not include Zoho`);

	const dm = await txt(`_dmarc.${domain}`);
	const dmarcRec = dm?.find((r) => /^v=DMARC1/i.test(r));
	const dmarc = !!dmarcRec;
	if (dm === null) warnings.push("Could not look up DMARC (DNS lookup failed)");
	else if (!dmarc) errors.push(`${domain} has no DMARC record`);
	else if (/p=none/i.test(dmarcRec!)) warnings.push("DMARC policy is p=none (monitoring only). Fine to start; tighten it later.");

	let dkim: boolean | null = null;
	for (const sel of dkimSelector ? [dkimSelector] : ["zmail", "zoho"]) {
		const r = await txt(`${sel}._domainkey.${domain}`);
		if (r?.some((x) => /v=DKIM1|p=/i.test(x))) { dkim = true; break; }
		if (dkimSelector && r) dkim = false;
	}
	if (dkim === false) errors.push(`DKIM record "${dkimSelector}._domainkey.${domain}" was not found`);
	else if (dkim === null) warnings.push("Could not confirm DKIM (selector unknown). Check Zoho Mail admin > Domains > DKIM is verified.");
	return { domain, spf, dmarc, dkim, errors, warnings };
}

/** Can this domain receive mail? (MX, or an A record as the fallback email servers accept.) */
export async function domainCanReceive(domain: string, doh: Doh): Promise<boolean> {
	try {
		if ((await doh(domain, "MX")).length > 0) return true;
		return (await doh(domain, "A")).length > 0;
	} catch {
		return true; // DNS hiccup: do not wrongly invalidate the lead
	}
}
