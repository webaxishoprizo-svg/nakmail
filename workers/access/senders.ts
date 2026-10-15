// Which From addresses a person may send as from a given mailbox.
//  - user:  only the mailbox itself (their alias)
//  - admin: the mailbox itself + any alias (assigned to someone, or an alias on the primary Zoho account).
//           Another admin's personal address is never offered.
import type { Session } from "../auth/session";
import { isAdminMailbox, primaryMailbox } from "../config";
import type { Env } from "../types";
import { listAccountAddresses } from "../zoho/client";
import { allAliases, allowedDomains } from "./store";

const TTL = 5 * 60_000;
let cache: { at: number; list: string[] } | null = null;
export const clearSenderCache = () => { cache = null; };

async function zohoAddresses(env: Env): Promise<string[]> {
	if (cache && Date.now() - cache.at < TTL) return cache.list;
	const list = await listAccountAddresses(env, primaryMailbox(env), allowedDomains(env));
	cache = { at: Date.now(), list };
	return list;
}

const lower = (s: string) => s.trim().toLowerCase();

export async function sendersFor(env: Env, session: Session, mailboxId: string): Promise<string[]> {
	const id = lower(mailboxId);
	if (session.role !== "admin") return [id];
	const set = new Set<string>(await allAliases(env));
	try {
		for (const a of await zohoAddresses(env)) set.add(a);
	} catch {
		// Zoho unavailable: fall back to the aliases assigned in the app.
	}
	return [id, ...[...set].filter((a) => a !== id && !isAdminMailbox(env, a)).sort()];
}

export async function canSendAs(env: Env, session: Session | undefined, mailboxId: string, from: string): Promise<boolean> {
	if (!session) return false;
	const f = lower(from);
	if (f === lower(mailboxId)) return true;
	if (session.role !== "admin" || isAdminMailbox(env, f)) return false;
	if ((await allAliases(env)).includes(f)) return true;
	try {
		return (await zohoAddresses(env)).includes(f);
	} catch {
		return false;
	}
}
