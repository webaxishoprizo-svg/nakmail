import { ArrowUp, ArrowUpRight, FileText, Image as ImageIcon, Mail, Paperclip, RotateCcw, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { escapeHtml, formatBytes } from "~/lib/utils";
import { COMPOSE_ATTACHMENT_ACCEPT, prepareComposeFiles } from "~/lib/compose-attachments";
import type { ComposeAttachment } from "~/types/compose";
import type { IrisAutomationAction, IrisEmailAction, IrisLeadData, IrisLeadDataSource } from "~/types/iris";
import IrisLeadDataPicker from "~/components/IrisLeadDataPicker";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import IrisLogo from "~/components/IrisLogo";
import { saveLocalDraftAttachments } from "~/lib/local-draft-attachments";

interface Msg {
	role: "user" | "assistant";
	content: string;
	href?: string;
}

const SUGGESTIONS = [
	"How many emails did we send today?",
	"How many did we receive this week?",
	"Write a polite follow-up email to a customer",
	"Create a weekday follow-up campaign from my attached lead sheet",
];

const PREVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** Iris answers questions about mail activity and helps write email drafts. */
export default function IrisChat() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const queryClient = useQueryClient();
	const { toggleAgentPanel, openComposeModal } = useUIStore();
	const [messages, setMessages] = useState<Msg[]>([]);
	const [leadData, setLeadData] = useState<IrisLeadData | null>(null);
	const [leadDataSource, setLeadDataSource] = useState<IrisLeadDataSource | null>(null);
	const [automationPending, setAutomationPending] = useState(false);
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [isAddingAttachments, setIsAddingAttachments] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages, busy, error]);

	const startNewChat = () => {
		setMessages([]);
		setLeadData(null);
		setLeadDataSource(null);
		setAutomationPending(false);
		setAttachments([]);
		setInput("");
		setError(null);
		setAttachmentError(null);
	};

	const addEmailAttachments = async (files: File[]) => {
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
		void addEmailAttachments(files);
	};

	const attachToEmail = () => {
		const latestReply = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
		const body = latestReply.trim()
			? `<p>${escapeHtml(latestReply).replace(/\n/g, "<br>")}</p>`
			: "";
		openComposeModal({ mode: "new", body, attachments });
		setAttachments([]);
		toggleAgentPanel();
	};

	const ask = async (text: string) => {
		const q = text.trim();
		if (!q || busy) return;

		const next: Msg[] = [...messages, { role: "user", content: q }];
		setMessages(next);
		setInput("");
		setError(null);
		setBusy(true);
		try {
			const { reply, action, automation, automationPending: needsAutomationDetails } = await api.irisChat(next, leadData ?? undefined, mailboxId || undefined, automationPending);
			let assistantReply = reply;
			if (action) assistantReply = await performEmailAction(action);
			let assistantMessage: Msg = { role: "assistant", content: assistantReply };
			if (automation) {
				assistantMessage = await performAutomationAction(automation);
				setAutomationPending(false);
			} else {
				setAutomationPending(!!needsAutomationDetails);
			}
			setMessages([...next, assistantMessage]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Iris could not answer. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	const performAutomationAction = async (action: IrisAutomationAction): Promise<Msg> => {
		if (!leadDataSource) throw new Error("Attach the lead spreadsheet again so Iris can import the full list into the campaign.");
		const { senders } = await api.autoSenders();
		const sender = senders.find((item) => item.alias.toLowerCase() === mailboxId.toLowerCase()) ?? senders[0];
		if (!sender) throw new Error("No eligible Zoho sender alias is available. Connect Zoho or add a permitted sending alias, then try again.");

		const created = await api.autoCreate({ ...action.campaign, sender_alias: sender.alias });
		let importSummary = "";
		try {
			const imported = await api.autoImport(created.id, leadDataSource);
			importSummary = ` Imported ${imported.added} leads${imported.duplicates ? `; ${imported.duplicates} duplicates skipped` : ""}${imported.suppressed ? `; ${imported.suppressed} suppressed addresses skipped` : ""}.`;
		} catch (cause) {
			importSummary = ` The campaign draft was created, but lead import failed: ${cause instanceof Error ? cause.message : "unknown error"}. Use the Leads tab in Automations to import the spreadsheet into it.`;
		}
		await queryClient.invalidateQueries({ queryKey: ["auto"] });
		const modeMessage = action.campaign.mode === "auto_send"
			? " It is configured for auto-send, but remains a draft until the campaign checks, legitimacy confirmation, temporary send permission, and engine switch are completed."
			: " It is draft-only, so after you start it, every generated email will wait for your approval.";
		return {
			role: "assistant",
			content: `Created “${action.campaign.name}” using ${sender.alias}.${importSummary}${modeMessage} Review the schedule, sender, and previews in Automations before starting it.`,
			href: `/mailbox/${encodeURIComponent(mailboxId)}/automations`,
		};
	};

	const performEmailAction = async (action: IrisEmailAction): Promise<string> => {
		if (!mailboxId) throw new Error("No mailbox is selected. Open Iris from a mailbox and try again.");
		if (attachments.some((attachment) => !attachment.content)) {
			throw new Error("One or more attached files are unavailable. Remove and attach them again before continuing.");
		}
		if (action.type === "send") {
			if (!action.to.length) throw new Error("Add a recipient email address before sending.");
			await api.sendEmail(mailboxId, {
				to: action.to,
				from: mailboxId,
				subject: action.subject,
				html: action.html,
				text: action.body,
				attachments: attachments.map(({ filename, type, content }) => ({ content, filename, type, disposition: "attachment" as const })),
			});
			setAttachments([]);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] }),
				queryClient.invalidateQueries({ queryKey: ["folders", mailboxId] }),
			]);
			return `Sent to ${action.to.join(", ")}\nSubject: ${action.subject}`;
		}

		const saved = await api.saveDraft(mailboxId, {
			to: action.to.join(", "),
			subject: action.subject,
			body: action.html,
			attachments: attachments.map(({ id, filename, type, size }) => ({ id, filename, type, size, disposition: "attachment" as const })),
		});
		if (saved.status === "draft" && attachments.length) {
			const localFiles = attachments.map((attachment, index) => ({
				...attachment,
				id: saved.attachmentIds?.[index] ?? attachment.id,
			}));
			try {
				await saveLocalDraftAttachments(mailboxId, saved.id, localFiles);
			} catch (cause) {
				await api.deleteEmail(mailboxId, saved.id).catch(() => {});
				throw new Error(`Draft files could not be saved in this browser: ${(cause as Error).message}`);
			}
		}
		setAttachments([]);
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] }),
			queryClient.invalidateQueries({ queryKey: ["folders", mailboxId] }),
		]);
		return `Saved to Drafts\nTo: ${action.to.join(", ") || "not specified"}\nSubject: ${action.subject}`;
	};

	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		void ask(input);
	};

	return (
		<section className="flex h-full min-h-0 flex-col bg-gradient-to-b from-white via-[#fafbfc] to-[#f5f7fa] text-[#171717]">
			<header className="flex shrink-0 items-center justify-between border-b border-[#e8ebef] bg-white/80 px-4 py-3.5 backdrop-blur-2xl sm:px-5">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[#171717] shadow-[0_4px_12px_rgba(23,23,23,0.12)]">
						<IrisLogo size={36} />
					</div>
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="truncate text-sm font-semibold tracking-[-0.01em]">Iris</h2>
							<span className="inline-flex items-center gap-1.5 rounded-full bg-[#f2f4f6] px-2 py-0.5 text-[10px] font-medium text-[#626a73]">
								<span className="size-1.5 rounded-full bg-[#171717]" aria-hidden="true" />
								AI assistant
							</span>
						</div>
						<p className="mt-0.5 truncate text-xs text-[#737b84]">Your inbox, with intelligence</p>
					</div>
				</div>
				<div className="ml-3 flex shrink-0 items-center gap-1">
					<button
						type="button"
				onClick={startNewChat}
				disabled={busy || isAddingAttachments}
						className="flex size-9 items-center justify-center rounded-xl border border-transparent text-[#737b84] transition hover:border-[#e8ebef] hover:bg-white hover:text-[#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/20 disabled:cursor-not-allowed disabled:opacity-40"
						aria-label="Start a new chat"
						title="New chat"
					>
						<RotateCcw className="size-4" />
					</button>
					<button
						type="button"
						onClick={toggleAgentPanel}
						className="flex size-9 items-center justify-center rounded-xl border border-transparent text-[#737b84] transition hover:border-[#e8ebef] hover:bg-white hover:text-[#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/20"
						aria-label="Close Iris chat"
						title="Close chat"
					>
						<X className="size-4" />
					</button>
				</div>
			</header>

			<div className="nak-iris-chat-scroll flex-1 overflow-y-auto px-4 py-5 sm:px-5">
				{messages.length === 0 ? (
					<div className="space-y-5">
						<div className="rounded-[1.4rem] border border-white/90 bg-white/75 p-4 shadow-[0_12px_36px_rgba(20,28,38,0.06)] backdrop-blur-xl sm:p-5">
							<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#e8ebef] bg-white/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#737b84]">
								<IrisLogo size={15} />
								Inbox assistant
							</div>
							<h3 className="text-[1.35rem] font-medium leading-tight tracking-[-0.035em]">How can I help?</h3>
							<p className="mt-2 text-[13px] leading-5 text-[#68717b]">
								Ask about your mail activity or get help drafting a thoughtful reply.
							</p>
						</div>

						<div>
							<div className="mb-2.5 flex items-center justify-between px-1">
								<p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#737b84]">Try a prompt</p>
								<span className="text-[11px] text-[#969da5]">{SUGGESTIONS.length} ideas</span>
							</div>
							<div className="space-y-2">
								{SUGGESTIONS.map((suggestion) => (
									<button
										key={suggestion}
										type="button"
										onClick={() => void ask(suggestion)}
										className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border border-[#e8ebef] bg-white/75 px-3.5 py-3 text-left text-[13px] leading-[1.35rem] text-[#333a42] shadow-[0_2px_8px_rgba(20,28,38,0.025)] transition duration-150 hover:-translate-y-0.5 hover:border-[#cfd4db] hover:bg-white hover:shadow-[0_8px_20px_rgba(20,28,38,0.07)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/20"
									>
										<span>{suggestion}</span>
										<ArrowUpRight className="size-4 shrink-0 text-[#9aa1a9] transition group-hover:text-[#171717]" />
									</button>
								))}
							</div>
						</div>
					</div>
				) : (
					<div className="space-y-5">
						{messages.map((message, index) =>
							message.role === "assistant" ? (
								<div key={index} className="flex items-start gap-2.5">
									<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#171717] shadow-sm">
										<IrisLogo size={29} />
									</div>
									<div className="max-w-[86%] rounded-2xl rounded-tl-md border border-white/90 bg-white/85 px-3.5 py-3 shadow-[0_6px_20px_rgba(20,28,38,0.055)] backdrop-blur-lg">
										<p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#858d96]">Iris</p>
										<p className="whitespace-pre-wrap break-words text-[13px] leading-[1.45rem] text-[#30363d]">{message.content}</p>
										{message.href && (
											<Link to={message.href} className="mt-3 inline-flex rounded-lg bg-[#171717] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#333333]">
												Open Automations
											</Link>
										)}
									</div>
								</div>
							) : (
								<div key={index} className="flex justify-end">
									<div className="max-w-[86%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[#171717] px-4 py-3 text-[13px] leading-[1.45rem] text-white shadow-[0_8px_20px_rgba(23,23,23,0.12)]">
										{message.content}
									</div>
								</div>
							),
						)}

						{busy && (
							<div className="flex items-center gap-2.5" role="status" aria-label="Iris is thinking">
								<div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#171717]">
									<IrisLogo size={29} />
								</div>
								<div className="flex h-10 items-center gap-1 rounded-2xl rounded-tl-md border border-white/90 bg-white/85 px-4 shadow-sm">
									<span className="size-1.5 animate-bounce rounded-full bg-[#6f7780] [animation-delay:-0.2s]" aria-hidden="true" />
									<span className="size-1.5 animate-bounce rounded-full bg-[#6f7780] [animation-delay:-0.1s]" aria-hidden="true" />
									<span className="size-1.5 animate-bounce rounded-full bg-[#6f7780]" aria-hidden="true" />
									<span className="ml-1 text-xs text-[#777f88]">Iris is thinking</span>
								</div>
							</div>
						)}
					</div>
				)}

				{error && (
					<div className="mt-4 rounded-2xl border border-[#eadbd8] bg-[#fff9f8] px-3.5 py-3 text-[13px] leading-5 text-[#7c3832]" role="alert">
						{error}
					</div>
				)}
				<div ref={endRef} />
			</div>

			<footer className="shrink-0 border-t border-[#e8ebef] bg-white/75 px-3.5 pb-3 pt-3 backdrop-blur-2xl sm:px-4">
				<div className="mb-3 space-y-2.5">
					<IrisLeadDataPicker value={leadData} onChange={(data, source) => { setLeadData(data); setLeadDataSource(data ? source ?? null : null); }} disabled={busy || isAddingAttachments} />
					<div className="flex flex-wrap items-center justify-between gap-2">
						<label className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-[#e3e7eb] bg-white/70 px-2.5 text-[11px] font-medium text-[#4c555f] transition hover:bg-white hover:text-[#171717] focus-within:ring-2 focus-within:ring-[#171717]/15 ${busy ? "pointer-events-none opacity-50" : ""}`}>
							<Paperclip className="size-3.5" />
							Attach documents / images
							<input
								type="file"
								multiple
								accept={COMPOSE_ATTACHMENT_ACCEPT}
								className="sr-only"
								disabled={busy || isAddingAttachments}
								onChange={onAttachmentChange}
							/>
						</label>
						{attachments.length > 0 && (
							<button
								type="button"
								disabled={busy || isAddingAttachments}
								onClick={attachToEmail}
								className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#171717] px-2.5 text-[11px] font-medium text-white transition hover:bg-[#333333] disabled:opacity-50"
							>
								<Mail className="size-3.5" />
								Use in email
							</button>
						)}
					</div>
					{attachments.length > 0 && (
						<div className="space-y-1.5">
							<div className="flex items-center justify-between px-1 text-[10px] text-[#828a93]">
								<span>{attachments.length} file{attachments.length === 1 ? "" : "s"} ready for the email draft</span>
								<span>{formatBytes(attachments.reduce((sum, file) => sum + file.size, 0))}</span>
							</div>
							{attachments.map((file) => (
								<div key={file.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-[#e8ebef] bg-white/80 px-2 py-1.5">
									{PREVIEW_IMAGE_TYPES.has(file.type) ? (
										<img src={`data:${file.type};base64,${file.content}`} alt="" className="size-7 shrink-0 rounded-md border border-[#eceff2] object-cover" />
									) : file.type.startsWith("image/") ? (
										<ImageIcon className="ml-1 size-4 shrink-0 text-[#737b84]" />
									) : (
										<FileText className="ml-1 size-4 shrink-0 text-[#737b84]" />
									)}
									<span className="min-w-0 flex-1 truncate text-[11px] text-[#4c555f]" title={file.filename}>{file.filename}</span>
									<button
										type="button"
										disabled={busy || isAddingAttachments}
										onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
										aria-label={`Remove ${file.filename}`}
										className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#858d96] hover:bg-[#f1f3f5] hover:text-[#171717] disabled:opacity-40"
									>
										<X className="size-3" />
									</button>
								</div>
							))}
						</div>
					)}
					{attachmentError && <p className="text-[11px] leading-4 text-[#9a413a]" role="alert">{attachmentError}</p>}
				</div>
				<form onSubmit={onSubmit} className="rounded-[1.35rem] border border-[#e1e5ea] bg-white p-2 shadow-[0_8px_24px_rgba(20,28,38,0.07)] transition focus-within:border-[#b9c0c8] focus-within:shadow-[0_10px_28px_rgba(20,28,38,0.1)]">
					<textarea
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void ask(input);
							}
						}}
						rows={2}
						maxLength={4000}
						placeholder="Message Iris..."
						aria-label="Message Iris"
						className="max-h-32 min-h-12 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] leading-5 text-[#24292f] outline-none placeholder:text-[#989fa7] focus:ring-0"
					/>
					<div className="flex items-center justify-between gap-3 px-1 pt-1">
						<span className="pl-1 text-[10px] text-[#9299a1]">Enter to send · Shift + Enter for a new line</span>
						<button
							type="submit"
							disabled={busy || !input.trim()}
							className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#171717] text-white shadow-sm transition hover:bg-[#333333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/25 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#d4d7db] disabled:text-white"
							aria-label="Send message to Iris"
							title="Send message"
						>
							<ArrowUp className="size-4" />
						</button>
					</div>
				</form>
				<p className="mt-2 text-center text-[10px] leading-4 text-[#969da5]">Iris can answer inbox questions, write emails, and set up scheduled lead campaigns.</p>
			</footer>
		</section>
	);
}
