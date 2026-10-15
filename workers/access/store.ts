// Alias <-> Google account assignments stored as compact records in ConfigDO's SQLite table.
import { isAdminGoogle, isAdminMailbox } from "../config";
import type { Env } from "../types";
import { configStore } from "../lib/config-store";

export interface Assignment { email: string; alias: string }

const PREFIX = "access/assign/";
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export class AccessError extends Error {
	constructor(message: string, public status = 400) {
		super(message);
	}
}

export const normalize = (s: unknown): string => String(s ?? "").trim().toLowerCase();
export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s);

const userPrefix = (email: string) => `${PREFIX}${encodeURIComponent(email)}/`;
const keyFor = (email: string, alias: string) => `${userPrefix(email)}${encodeURIComponent(alias)}`;

function parseKey(key: string): Assignment | null {
	if (!key.startsWith(PREFIX)) return null;
	const parts = key.slice(PREFIX.length).split("/");
	if (parts.length !== 2) return null;
	try {
		return { email: decodeURIComponent(parts[0]), alias: decodeURIComponent(parts[1]) };
	} catch {
		return null;
	}
}

async function listKeys(env: Env, prefix: string, max = Infinity): Promise<string[]> {
	return configStore(env).listKeys(prefix, Number.isFinite(max) ? max : 5000);
}

export function allowedDomains(env: Env): string[] {
	return (env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export async function listAssignments(env: Env): Promise<Assignment[]> {
	const out: Assignment[] = [];
	for (const k of await listKeys(env, PREFIX)) {
		const a = parseKey(k);
		if (a) out.push(a);
	}
	return out.sort((x, y) => x.alias.localeCompare(y.alias) || x.email.localeCompare(y.email));
}

export async function aliasesFor(env: Env, email: string): Promise<string[]> {
	const keys = await listKeys(env, userPrefix(normalize(email)));
	return keys.map(parseKey).filter((a): a is Assignment => !!a).map((a) => a.alias).sort();
}

export async function hasAnyAssignment(env: Env, email: string): Promise<boolean> {
	return (await listKeys(env, userPrefix(normalize(email)), 1)).length > 0;
}

export async function hasAlias(env: Env, email: string, alias: string): Promise<boolean> {
	return configStore(env).hasValue(keyFor(normalize(email), normalize(alias)));
}

export async function allAliases(env: Env): Promise<string[]> {
	return [...new Set((await listAssignments(env)).map((a) => a.alias))].sort();
}

/** Validate and store an assignment. Returns true if it was newly created. */
export async function addAssignment(env: Env, input: { email: unknown; alias: unknown }): Promise<boolean> {
	const email = normalize(input.email);
	const alias = normalize(input.alias);
	if (!isEmail(email)) throw new AccessError("Enter a valid Google account email");
	if (!isEmail(alias)) throw new AccessError("Enter a valid alias email address");
	if (!allowedDomains(env).includes(alias.split("@")[1])) {
		throw new AccessError(`Alias must be on one of: ${allowedDomains(env).join(", ")}`);
	}
	if (isAdminMailbox(env, alias)) {
		throw new AccessError("That is an admin's own mailbox. Assign an alias instead.");
	}
	if (isAdminGoogle(env, email)) {
		throw new AccessError("That Google account is an admin and already has access");
	}
	const key = keyFor(email, alias);
	return configStore(env).putValueIfAbsent(key, JSON.stringify({ createdAt: new Date().toISOString() }));
}

/** Returns true if an assignment was removed. */
export async function removeAssignment(env: Env, input: { email: unknown; alias: unknown }): Promise<boolean> {
	const email = normalize(input.email);
	const alias = normalize(input.alias);
	const key = keyFor(email, alias);
	return configStore(env).deleteValue(key);
}
