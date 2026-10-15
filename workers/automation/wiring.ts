// Connects the engine to the real world: the AutomationDO, Workers AI, Zoho sending, the mailbox inbox and DNS.
import { primaryMailbox } from "../config";
import { sendEmail } from "../email-sender";
import { irisChat } from "../iris/llm";
import { getMailboxStub } from "../lib/email-helpers";
import type { Env } from "../types";
import { cloudflareDoh, domainCanReceive } from "./dns";
import { runTick, type AutomationApi, type EngineDeps } from "./engine";
import { PUBLIC_METHODS } from "./store";
import { writeEmail, type WriterDeps } from "./writer";
import { configStore } from "../lib/config-store";

export function automationStore(env: Env): AutomationApi {
	const stub = env.AUTOMATION.get(env.AUTOMATION.idFromName("main")) as any;
	const allowed = new Set<string>(PUBLIC_METHODS);
	return new Proxy({} as AutomationApi, {
		get: (_t, name) => (typeof name === "string" && allowed.has(name) ? (...args: unknown[]) => stub.call(name, args) : undefined),
	});
}

const WRITER_DEFAULT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WRITER_FALLBACK = "@cf/meta/llama-4-scout-17b-16e-instruct";

export function writerDeps(env: Env): WriterDeps {
	const model = String((env as any).WRITER_MODEL || WRITER_DEFAULT);
	return {
		rng: Math.random,
		chat: async (messages, opts) => {
			try { return await irisChat(env, messages, { ...opts, model, workersAiOnly: true }); }
			catch (e) {
				if (model === WRITER_FALLBACK) throw e;
				return irisChat(env, messages, { ...opts, model: WRITER_FALLBACK, workersAiOnly: true });
			}
		},
	};
}

export function engineDeps(env: Env, store: AutomationApi = automationStore(env)): EngineDeps {
	const writer = writerDeps(env);
	return {
		now: () => Date.now(),
		store,
		write: (job) => writeEmail(job, writer),
		send: async (m) => { await sendEmail(env, { to: m.to, from: m.from, subject: m.subject, text: m.text } as any); },
		mxOk: async (domain) => {
			const cached = await store.getDomainCache(domain, Date.now());
			if (cached !== null) return cached;
			const ok = await domainCanReceive(domain, cloudflareDoh);
			await store.setDomainCache(domain, ok, Date.now());
			return ok;
		},
		inbound: async (since) => {
			const rows = await getMailboxStub(env, primaryMailbox(env)).getInboundSince(new Date(since).toISOString(), 500);
			return rows.map((r) => ({ sender: r.sender ?? "", subject: r.subject ?? "", body: r.body ?? "", date: Date.parse(r.date) || 0 }));
		},
		syncFresh: async () => {
			const value = await configStore(env).getValue("automation/last_sync.json");
			if (!value) return false;
			try { return Date.now() - (JSON.parse(value).at ?? 0) < 10 * 60_000; } catch { return false; }
		},
	};
}

/** Called every minute by the cron trigger. Never throws: a failure is logged and retried next minute. */
export async function automationTick(env: Env): Promise<void> {
	try {
		const r = await runTick(engineDeps(env));
		if (r.action !== "idle" && r.action !== "off") console.log(`automation: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
	} catch (e) {
		console.error("automation tick failed:", (e as Error).message);
	}
}
