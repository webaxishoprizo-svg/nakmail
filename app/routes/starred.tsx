import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { Button, Loader, Pagination } from "@cloudflare/kumo";
import { StarIcon } from "@phosphor-icons/react";
import MailboxSplitView from "~/components/MailboxSplitView";
import { useUIStore } from "~/hooks/useUIStore";
import { getSnippetText } from "~/lib/utils";
import { formatListDate } from "shared/dates";
import { useSearchEmails, SEARCH_PAGE_SIZE } from "~/queries/search";
import { useUpdateEmail } from "~/queries/emails";
import type { Email } from "~/types";

export default function StarredRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { selectedEmailId, isComposing, selectEmail, closePanel } = useUIStore();
	const [page, setPage] = useState(1);
	const previousMailbox = useRef(mailboxId);
	const updateEmail = useUpdateEmail();
	const { data, isLoading } = useSearchEmails(mailboxId, "is:starred", page);
	const emails = data?.results ?? [];
	const totalCount = data?.totalCount ?? 0;

	useEffect(() => {
		if (previousMailbox.current !== mailboxId) {
			previousMailbox.current = mailboxId;
			setPage(1);
			closePanel();
		}
	}, [mailboxId, closePanel]);

	const toggleStar = (event: React.MouseEvent, email: Email) => {
		event.stopPropagation();
		if (!mailboxId) return;
		updateEmail.mutate({ mailboxId, id: email.id, data: { starred: false } });
	};

	return (
		<MailboxSplitView selectedEmailId={selectedEmailId} isComposing={isComposing}>
			<div className="flex min-h-0 flex-1 flex-col bg-white">
				<div className="border-b border-[#e5e5e5] px-5 py-5 md:px-7">
					<p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b7280]">Your mailbox</p>
					<h1 className="mt-1 text-2xl font-semibold tracking-tight text-[#202124]">Starred</h1>
					<p className="mt-1 text-sm text-[#687078]">Important conversations you marked to come back to.</p>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{isLoading ? <div className="flex justify-center py-20"><Loader size="lg" /></div> : emails.length ? emails.map((email) => <div key={email.id} role="button" tabIndex={0} onClick={() => selectEmail(email.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEmail(email.id); } }} className={`group flex cursor-pointer items-center gap-3 border-b border-[#eceff1] px-4 py-3.5 hover:bg-[#f8f9fa] md:px-7 ${selectedEmailId === email.id ? "bg-[#eaf1fb]" : "bg-white"}`}>
						<div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className={`truncate text-sm ${email.read ? "font-medium text-[#343a40]" : "font-semibold text-[#202124]"}`}>{email.sender}</span><span className="ml-auto shrink-0 text-xs text-[#747b83]">{formatListDate(email.date)}</span></div><div className="mt-1 truncate text-sm text-[#343a40]">{email.subject}</div><div className="mt-1 truncate text-xs text-[#747b83]">{getSnippetText(email.snippet, 140)}</div></div>
						<Button variant="ghost" shape="square" size="sm" icon={<StarIcon size={18} weight="fill" className="text-amber-500" />} onClick={(event) => toggleStar(event, email)} aria-label="Remove star" />
					</div>) : <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center"><StarIcon size={34} weight="thin" className="mb-3 text-[#9aa0a6]"/><h2 className="text-base font-semibold text-[#202124]">Nothing starred yet</h2><p className="mt-1 max-w-sm text-sm text-[#687078]">Star a conversation in your inbox to keep it easy to find here.</p></div>}
				</div>
				{totalCount > SEARCH_PAGE_SIZE && <div className="flex justify-center border-t border-[#e5e5e5] py-3"><Pagination page={page} setPage={setPage} perPage={SEARCH_PAGE_SIZE} totalCount={totalCount} /></div>}
			</div>
		</MailboxSplitView>
	);
}
