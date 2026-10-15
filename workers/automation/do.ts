import { DurableObject } from "cloudflare:workers";
import { adminAccounts } from "../config";
import type { Env } from "../types";
import { isSenderBlocked } from "./rules";
import { AutomationStore, PUBLIC_METHODS } from "./store";

const ALLOWED = new Set<string>(PUBLIC_METHODS);

/** One global instance holds all campaigns, leads and the send log (SQLite). */
export class AutomationDO extends DurableObject<Env> {
	private store: AutomationStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const extra = String((env as any).COLD_BLOCKED_SENDERS ?? "").split(",");
		this.store = new AutomationStore(ctx.storage.sql as any, {
			isSenderBlocked: (alias) => isSenderBlocked(alias, adminAccounts(env).map((a) => a.mailbox), extra),
		});
	}

	async call(method: string, args: unknown[] = []): Promise<unknown> {
		if (!ALLOWED.has(method)) throw new Error(`Unknown automation method: ${method}`);
		return (this.store as any)[method](...args);
	}
}
