// Real numbers for iRIS to quote (never guessed by the model).
import { allAliases, aliasesFor } from "../access/store";
import type { Session } from "../auth/session";
import { adminForGoogle, primaryMailbox } from "../config";
import { activitySince, summarizeActivity } from "../lib/analytics";
import { getMailboxStub } from "../lib/email-helpers";
import type { Env } from "../types";

type Pair = { sent: number; received: number };
export interface MailboxFacts { mailbox: string; today: Pair; yesterday: Pair; last7: Pair }
export interface Facts {
	now: string; timezone: string;
	total: { today: Pair; yesterday: Pair; last7: Pair };
	mailboxes: MailboxFacts[];
	note: string;
}

const pair = (p: Pair): Pair => ({ sent: p.sent, received: p.received });
const addPair = (a: Pair, b: Pair): Pair => ({ sent: a.sent + b.sent, received: a.received + b.received });
const zero = (): Pair => ({ sent: 0, received: 0 });

export const timezoneOf = (env: Env): string => String((env as any).TIMEZONE || "Asia/Kolkata");

export async function mailboxFacts(env: Env, mailbox: string, now: Date): Promise<MailboxFacts> {
	const rows = await getMailboxStub(env, mailbox).getActivityRows(activitySince(now));
	const a = summarizeActivity(rows, timezoneOf(env), now);
	return { mailbox, today: pair(a.today), yesterday: pair(a.yesterday), last7: pair(a.last7) };
}

/**
 * Totals avoid double counting: the PRIMARY admin's mailbox already contains all mail of the primary Zoho
 * account (alias traffic included). Another admin's mailbox is a separate account, so aliases are added.
 * A user only has their own alias mailboxes.
 */
export async function buildFacts(env: Env, session: Session, now = new Date()): Promise<Facts> {
	const own = session.role === "admin" ? adminForGoogle(env, session.email)?.mailbox : undefined;
	const aliases = session.role === "admin" ? await allAliases(env) : await aliasesFor(env, session.email);
	const targets = [...(own ? [own] : []), ...aliases.filter((a) => a !== own)];

	const mailboxes: MailboxFacts[] = [];
	for (const m of targets) {
		try { mailboxes.push(await mailboxFacts(env, m, now)); } catch { /* skip unreadable mailbox */ }
	}

	const ownFacts = mailboxes.find((m) => m.mailbox === own);
	const aliasFacts = mailboxes.filter((m) => m.mailbox !== own);
	const includeAliases = !(own && own === primaryMailbox(env) && ownFacts);
	const sum = (k: "today" | "yesterday" | "last7") =>
		[...(ownFacts ? [ownFacts] : []), ...(includeAliases ? aliasFacts : [])].reduce((acc, m) => addPair(acc, m[k]), zero());

	return {
		now: now.toISOString(), timezone: timezoneOf(env),
		total: { today: sum("today"), yesterday: sum("yesterday"), last7: sum("last7") },
		mailboxes,
		note: session.role === "admin"
			? "total = all mail handled by this admin's account including aliases; mailboxes = per-mailbox breakdown"
			: "total = the alias mailboxes this person can access",
	};
}
