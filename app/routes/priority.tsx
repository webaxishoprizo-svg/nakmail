import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { ArrowBendUpLeftIcon, FireIcon, SparkleIcon } from "@phosphor-icons/react";
import MailboxSplitView from "~/components/MailboxSplitView";
import { useUIStore } from "~/hooks/useUIStore";
import { getSnippetText } from "~/lib/utils";
import { formatListDate } from "shared/dates";
import { useEmails } from "~/queries/emails";
import type { Email } from "~/types";

type PriorityView = "all" | "reply" | "leads";

export default function PriorityRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [view, setView] = useState<PriorityView>("all");
	const { selectedEmailId, isComposing, selectEmail } = useUIStore();
	const { data: inboxData, isLoading: inboxLoading } = useEmails(
		mailboxId,
		{ folder: "inbox", page: "1", limit: "100" },
		{ refetchInterval: 30_000 },
	);
	const { data: hotData, isLoading: hotLoading } = useEmails(
		mailboxId,
		{ folder: "hot", page: "1", limit: "100" },
		{ refetchInterval: 30_000 },
	);

	const replies = (inboxData?.emails ?? []).filter((email) => email.needs_reply);
	const hotLeads = hotData?.emails ?? [];
	const priorities = useMemo(() => {
		const byId = new Map<string, Email>();
		for (const email of [...hotLeads, ...replies]) byId.set(email.id, email);
		return [...byId.values()].sort(
			(a, b) => Number(b.needs_reply) - Number(a.needs_reply) || (b.score ?? 0) - (a.score ?? 0),
		);
	}, [hotLeads, replies]);
	const visible = view === "reply" ? replies : view === "leads" ? hotLeads : priorities;
	const loading = inboxLoading || (view !== "reply" && hotLoading);

	return (
		<MailboxSplitView selectedEmailId={selectedEmailId} isComposing={isComposing}>
			<div className="flex min-h-0 flex-1 flex-col bg-white">
				<div className="border-b border-[#e5e5e5] px-5 py-5 md:px-7">
					<p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b7280]">Sales inbox</p>
					<div className="mt-1 flex flex-wrap items-end justify-between gap-4">
						<div><h1 className="text-2xl font-semibold tracking-tight text-[#202124]">Priority</h1><p className="mt-1 text-sm text-[#687078]">Conversations to answer and high intent leads from Zoho.</p></div>
						<div className="flex rounded-full bg-[#f1f3f4] p-1">
							{(["all", "reply", "leads"] as PriorityView[]).map((item) => <button key={item} type="button" onClick={() => setView(item)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${view === item ? "bg-white text-[#202124] shadow-sm" : "text-[#5f6368] hover:text-[#202124]"}`}>{item === "all" ? "All priority" : item === "reply" ? "Needs reply" : "Hot leads"}</button>)}
						</div>
					</div>
					<div className="mt-4 flex gap-5 text-xs text-[#5f6368]"><span><ArrowBendUpLeftIcon className="mr-1 inline" size={14} />{replies.length} awaiting reply</span><span><FireIcon className="mr-1 inline text-orange-500" size={14} />{hotLeads.length} hot leads</span></div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{loading ? <div className="space-y-1 p-5">{[0,1,2,3,4].map((n) => <div key={n} className="h-[68px] animate-pulse rounded-lg bg-[#f5f6f7]" />)}</div> : visible.length ? visible.map((email) => <button key={email.id} type="button" onClick={() => selectEmail(email.id)} className={`group flex w-full items-start gap-3 border-b border-[#eceff1] px-5 py-4 text-left hover:bg-[#f8f9fa] md:px-7 ${selectedEmailId === email.id ? "bg-[#eaf1fb]" : "bg-white"}`}>
						<span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${email.needs_reply ? "bg-amber-500" : "bg-red-500"}`} />
						<span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-[#202124]">{email.sender}</span>{email.needs_reply ? <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Needs reply</span> : <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">Hot · {email.score ?? 0}</span>}<span className="ml-auto shrink-0 text-xs text-[#747b83]">{formatListDate(email.date)}</span></span><span className="mt-1 block truncate text-sm text-[#343a40]">{email.subject}</span><span className="mt-1 block truncate text-xs text-[#747b83]">{getSnippetText(email.snippet, 140)}</span></span>
						<span className="mt-1 hidden shrink-0 text-[#8a9096] group-hover:text-[#315f9f] sm:block"><SparkleIcon size={17} /></span>
					</button>) : <div className="flex h-full min-h-64 flex-col items-center justify-center px-6 text-center"><SparkleIcon size={32} className="mb-3 text-[#9aa0a6]"/><h2 className="text-base font-semibold text-[#202124]">No priority conversations</h2><p className="mt-1 max-w-sm text-sm text-[#687078]">New replies and high intent leads will show up here as your inbox syncs.</p></div>}
				</div>
			</div>
		</MailboxSplitView>
	);
}
