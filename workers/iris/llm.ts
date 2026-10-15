// iRIS model adapter. Uses the configured hosted API, otherwise falls back to Workers AI on this account.
// IRIS_API_FORMAT selects OpenAI-compatible chat completions (default) or the Flowlith iRIS chat API.
import type { Env } from "../types";

export interface ChatMsg { role: "system" | "user" | "assistant"; content: string }
export interface ChatOpts { temperature?: number; maxTokens?: number; model?: string; workersAiOnly?: boolean }

const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export class IrisError extends Error {
	constructor(message: string, public status = 502) { super(message); }
}

const endpoint = (base: string) => (/\/chat\/completions\/?$/.test(base) ? base : `${base.replace(/\/+$/, "")}/chat/completions`);
const irisChatEndpoint = (base: string) => (/\/api\/chat\/?$/.test(base) ? base : `${base.replace(/\/+$/, "")}/api/chat`);

function irisChatRequest(messages: ChatMsg[]) {
	const system = messages.filter((message) => message.role === "system").map((message) => message.content.trim()).filter(Boolean).join("\n\n");
	const conversation = messages.filter((message) => message.role !== "system");
	const current = [...conversation].reverse().find((message) => message.role === "user");
	if (!current) throw new IrisError("iRIS needs a user message", 400);
	const history = conversation.slice(0, conversation.lastIndexOf(current)).slice(-12);
	const message = system
		? `Instructions and relevant inbox context for this reply:\n${system}\n\nUser's latest message:\n${current.content}`
		: current.content;
	return { message, history };
}

async function workersAiChat(env: Env, messages: ChatMsg[], opts: ChatOpts): Promise<string> {
	const e = env as any;
	if (!e.AI) throw new IrisError("No AI configured: set IRIS_API_URL or enable the Workers AI binding", 503);
	try {
		const result = await e.AI.run(opts.model || e.IRIS_WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL, {
			messages,
			temperature: opts.temperature ?? 0.4,
			max_tokens: opts.maxTokens ?? 700,
		});
		const text = result?.response ?? result?.choices?.[0]?.message?.content ?? result?.result?.response;
		if (typeof text !== "string" || !text.trim()) throw new Error("empty response");
		return text.trim();
	} catch (err) {
		if (err instanceof IrisError) throw err;
		const message = (err as Error).message;
		if (message.includes("Binding AI needs to be run remotely")) {
			throw new IrisError("Workers AI needs Cloudflare remote bindings. Start local dev with remote bindings enabled, or configure IRIS_API_URL.", 503);
		}
		throw new IrisError(`Workers AI failed: ${message}`);
	}
}

export async function irisChat(env: Env, messages: ChatMsg[], opts: ChatOpts = {}): Promise<string> {
	const e = env as any;
	const temperature = opts.temperature ?? 0.4;
	const max_tokens = opts.maxTokens ?? 700;

	if (e.IRIS_API_URL && !opts.workersAiOnly) {
		let hostedError: IrisError;
		try {
			const irisChatFormat = e.IRIS_API_FORMAT === "iris-chat";
			const requestBody = irisChatFormat
				? irisChatRequest(messages)
				: { model: e.IRIS_MODEL || "default", messages, temperature, max_tokens };
			const res = await fetch(irisChatFormat ? irisChatEndpoint(String(e.IRIS_API_URL)) : endpoint(String(e.IRIS_API_URL)), {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(e.IRIS_API_KEY ? { Authorization: `Bearer ${e.IRIS_API_KEY}` } : {}) },
				body: JSON.stringify(requestBody),
				signal: AbortSignal.timeout(20_000),
			}).catch((err) => { throw new IrisError(`iRIS API unreachable: ${(err as Error).message}`); });
			if (!res.ok) throw new IrisError(`iRIS API error ${res.status}`);
			const j = (await res.json().catch(() => null)) as any;
			const text = j?.reply ?? j?.choices?.[0]?.message?.content ?? j?.response ?? j?.result?.response;
			if (typeof text !== "string" || !text.trim()) throw new IrisError("iRIS API returned no text");
			return text.trim();
		} catch (err) {
			hostedError = err instanceof IrisError ? err : new IrisError("iRIS API request failed");
		}

		// Keep Iris available if the configured provider is temporarily unhealthy.
		if (!e.AI) throw hostedError;
		try { return await workersAiChat(env, messages, opts); }
		catch (fallbackError) {
			throw new IrisError(`${hostedError.message}; fallback unavailable: ${(fallbackError as Error).message}`, 503);
		}
	}

	return workersAiChat(env, messages, opts);
}
