import { useState, useRef, useEffect, type ChangeEvent } from "react";
import { ArrowUp, Mail, UserRound } from "lucide-react";
import api from "~/services/api";
import IrisLogo from "~/components/IrisLogo";
import IrisLeadDataPicker from "~/components/IrisLeadDataPicker";
import ComposeAttachments from "~/components/ComposeAttachments";
import { escapeHtml } from "~/lib/utils";
import { prepareComposeFiles } from "~/lib/compose-attachments";
import type { ComposeAttachment } from "~/types/compose";
import type { IrisLeadData } from "~/types/iris";
import { useUIStore } from "~/hooks/useUIStore";

const SUGGESTIONS = [
	"Show me today's hottest leads",
	"Which clients are waiting for a response?",
	"Summarize today's inbox",
	"Find unanswered sales enquiries",
	"Draft follow-ups for my leads",
	"What emails require my attention?",
];

interface Message {
	role: "user" | "assistant";
	content: string;
}

export default function AssistantRoute() {
	const { openComposeModal } = useUIStore();
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [leadData, setLeadData] = useState<IrisLeadData | null>(null);
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	const [isAddingAttachments, setIsAddingAttachments] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, loading]);

	const addAttachments = async (files: File[]) => {
		setIsAddingAttachments(true);
		try {
			const { accepted, errors } = await prepareComposeFiles(files, attachments);
			setAttachmentError(errors.length ? errors.slice(0, 3).join(" ") : null);
			if (accepted.length) setAttachments((current) => [...current, ...accepted]);
		} finally {
			setIsAddingAttachments(false);
		}
	};

	const onAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.currentTarget.files ?? []);
		event.currentTarget.value = "";
		void addAttachments(files);
	};

	const useDraftInEmail = () => {
		const latestReply = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
		const body = latestReply.trim() ? `<p>${escapeHtml(latestReply).replace(/\n/g, "<br>")}</p>` : "";
		openComposeModal({ mode: "new", body, attachments });
		setAttachments([]);
	};

	const ask = async (q: string) => {
		const text = q.trim();
		if (!text || loading) return;

		const next: Message[] = [...messages, { role: "user", content: text }];
		setMessages(next);
		setInput("");
		setError(null);
		setLoading(true);

		try {
			const res = await api.irisChat(next, leadData ?? undefined);
			setMessages([...next, { role: "assistant", content: res.reply }]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Iris could not respond. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="h-full overflow-y-auto bg-gradient-to-b from-[#f5f8ff] via-white to-white px-4 py-8 sm:px-8 font-sans flex flex-col">
			<div className="max-w-4xl w-full mx-auto flex-1 flex flex-col justify-between">
				{/* Top / Welcome */}
				{messages.length === 0 ? (
					<div className="my-auto py-12 text-center max-w-2xl mx-auto">
						<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#eaf1fb] text-[#315f9f] mx-auto mb-4 shadow-sm">
							<IrisLogo size={44} />
						</div>
						<h2 className="nak-display text-4xl text-[#171717]">Ask Iris AI</h2>
						<p className="text-sm text-[#5f6368] mt-2 leading-relaxed">
							Natural-language intelligence over your inbox, leads, and follow-ups. Only relevant threads are retrieved — never your whole mailbox.
						</p>

						{/* Suggestion pills */}
						<div className="grid sm:grid-cols-2 gap-2.5 mt-8 text-left">
							{SUGGESTIONS.map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => ask(s)}
									className="p-3 text-xs rounded-xl bg-white border border-[#e5e5e5] text-[#171717] hover:border-[#315f9f] hover:bg-[#f6f6f6] transition-all cursor-pointer shadow-2xs"
								>
									{s}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="space-y-4 py-4 flex-1">
						{messages.map((m, idx) => (
							<div
								key={idx}
								className={`flex items-start gap-3 ${
									m.role === "user" ? "justify-end" : "justify-start"
								}`}
							>
								{m.role === "assistant" && (
									<div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eaf1fb] text-[#315f9f] shrink-0 mt-0.5">
								<IrisLogo size={24} />
									</div>
								)}

								<div
									className={`max-w-xl rounded-2xl px-4 py-3 text-sm leading-relaxed ${
										m.role === "user"
											? "bg-[#171717] text-white rounded-br-none"
											: "bg-[#f6f6f6] border border-[#e5e5e5] text-[#171717] rounded-bl-none"
									}`}
								>
									{m.content}
								</div>

								{m.role === "user" && (
									<div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#171717] text-white shrink-0 mt-0.5">
										<UserRound className="h-4 w-4" />
									</div>
								)}
							</div>
						))}

						{loading && (
							<div className="flex items-center gap-2 text-xs text-[#5f6368] py-2">
							<IrisLogo size={16} className="animate-pulse" />
								<span>Iris is analyzing your mailbox...</span>
							</div>
						)}
						<div ref={endRef} />
					</div>
				)}

				{error && <div className="mx-auto mb-3 w-full max-w-4xl rounded-xl border border-[#eadbd8] bg-[#fff9f8] px-4 py-3 text-sm text-[#7c3832]" role="alert">{error}</div>}

				{/* Input Composer */}
				<div className="pt-4 sticky bottom-0 bg-transparent">
					<div className="mx-auto mb-3 w-full max-w-4xl">
						<IrisLeadDataPicker value={leadData} onChange={setLeadData} disabled={loading || isAddingAttachments} />
						<ComposeAttachments
							attachments={attachments}
							addAttachments={addAttachments}
							removeAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
							disabled={loading || isAddingAttachments}
						/>
						{attachmentError && <p className="mt-2 text-xs text-[#9a413a]" role="alert">{attachmentError}</p>}
						{attachments.length > 0 && (
							<button type="button" onClick={useDraftInEmail} disabled={loading || isAddingAttachments} className="mt-2 inline-flex h-9 items-center gap-2 rounded-lg bg-[#171717] px-3.5 text-xs font-medium text-white transition hover:bg-[#333333] disabled:opacity-50">
								<Mail className="size-3.5" />
								Use reply and files in email
							</button>
						)}
					</div>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							ask(input);
						}}
						className="flex items-center gap-2 rounded-full border border-[#e5e5e5] bg-white px-5 py-2.5 shadow-md focus-within:border-[#315f9f] transition-all"
					>
						<input
							type="text"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							placeholder="Ask about your inbox, leads, or draft replies..."
							className="flex-1 bg-transparent text-sm text-[#171717] outline-none placeholder:text-[#5f6368]"
						/>
						<button
							type="submit"
							disabled={!input.trim() || loading}
							aria-label="Send message to Iris"
							title="Send message"
							className="flex h-8 w-8 items-center justify-center rounded-full bg-[#171717] text-white disabled:opacity-40 cursor-pointer transition-opacity"
						>
							<ArrowUp className="h-4 w-4" />
						</button>
					</form>
					<p className="text-[11px] text-[#5f6368] text-center mt-2 pb-2">
						Iris AI references email subjects, messages, and sender information to provide intelligent insights.
					</p>
				</div>
			</div>
		</div>
	);
}
