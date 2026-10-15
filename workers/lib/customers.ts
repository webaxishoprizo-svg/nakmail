// Optional "regular customers" list (emails and/or whole domains) that boosts lead scores.
import type { Customers } from "./scoring";
import type { Env } from "../types";
import { configStore } from "./config-store";

const KEY = "scoring/customers.json";
const clean = (v: unknown, max = 5000): string[] =>
	[...new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean))].slice(0, max);

export async function loadCustomers(env: Env): Promise<Customers> {
	try {
		const value = await configStore(env).getValue(KEY);
		const j = value ? JSON.parse(value) : {};
		return { emails: new Set(clean(j.emails)), domains: new Set(clean(j.domains)) };
	} catch {
		return { emails: new Set(), domains: new Set() };
	}
}

export async function saveCustomers(env: Env, input: { emails?: unknown; domains?: unknown }): Promise<{ emails: number; domains: number }> {
	const emails = clean(input.emails).filter((e) => e.includes("@"));
	const domains = clean(input.domains).map((d) => d.replace(/^@/, "")).filter((d) => d.includes("."));
	await configStore(env).putValue(KEY, JSON.stringify({ emails, domains }));
	return { emails: emails.length, domains: domains.length };
}
