// Which mailboxes a signed-in person may see.
//  - user:  only the aliases assigned to their Google account
//  - admin: their own Zoho mailbox + every alias mailbox. Another admin's personal mailbox stays
//           private unless ADMINS_SHARE_MAILBOXES is "true".
import type { Session } from "../auth/session";
import { adminForGoogle, adminAccounts, adminsShareMailboxes, isAdminMailbox } from "../config";
import type { Env } from "../types";
import { allAliases, aliasesFor } from "./store";

export function canAdminOpen(env: Env, session: Session, mailboxId: string): boolean {
	const id = mailboxId.trim().toLowerCase();
	if (!isAdminMailbox(env, id)) return true; // alias mailboxes
	if (adminsShareMailboxes(env)) return true;
	return adminForGoogle(env, session.email)?.mailbox === id;
}

/** Addresses the home screen should list (and may auto-create) for this session. */
export async function visibleMailboxes(env: Env, session: Session): Promise<string[]> {
	if (session.role !== "admin") return aliasesFor(env, session.email);
	const own = adminForGoogle(env, session.email)?.mailbox;
	const others = adminsShareMailboxes(env)
		? adminAccounts(env).map((a) => a.mailbox).filter((m) => m !== own)
		: [];
	return [...new Set([...(own ? [own] : []), ...others, ...(await allAliases(env))])];
}
