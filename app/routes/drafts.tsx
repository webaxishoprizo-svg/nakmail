import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Send, Trash2, Users, X } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useEmails } from "~/queries/emails";
import { getSnippetText } from "~/lib/utils";
import { formatListDate } from "shared/dates";
import api from "~/services/api";

type SharedDraft = {
	id: string; name: string; to: string; cc: string; bcc: string;
	subject: string; body: string; createdBy: string; createdAt: string; updatedAt: string;
};

export default function DraftsRoute() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const queryClient = useQueryClient();
	const { startCompose } = useUIStore();
	const { data: personalData, isLoading: personalLoading } = useEmails(mailboxId, { folder: "draft", page: "1", limit: "100" });
	const { data: sharedDrafts = [], isLoading: sharedLoading } = useQuery({
		queryKey: ["shared-drafts", mailboxId],
		queryFn: () => api.listSharedDrafts(mailboxId) as Promise<SharedDraft[]>,
		enabled: !!mailboxId,
	});
	const [isCreating, setIsCreating] = useState(false);
	const [name, setName] = useState("");
	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState("");
	const createDraft = useMutation({
		mutationFn: () => api.createSharedDraft(mailboxId, { name: name.trim(), to, cc, bcc, subject, body }),
		onSuccess: () => {
			setName(""); setTo(""); setCc(""); setBcc(""); setSubject(""); setBody("");
			setIsCreating(false); setError("");
			queryClient.invalidateQueries({ queryKey: ["shared-drafts", mailboxId] });
		},
		onError: (cause) => setError((cause as Error).message),
	});
	const deleteDraft = useMutation({
		mutationFn: (draftId: string) => api.deleteSharedDraft(mailboxId, draftId),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shared-drafts", mailboxId] }),
		onError: (cause) => setError((cause as Error).message),
	});
	const personalDrafts = personalData?.emails ?? [];

	return (
		<div className="h-full overflow-y-auto bg-white">
			<div className="mx-auto max-w-5xl px-5 py-7 md:px-9 md:py-9">
				<div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#e5e5e5] pb-6">
					<div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b7280]">Your mailbox</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-[#202124]">Drafts</h1><p className="mt-1 text-sm text-[#687078]">Private messages and reusable drafts for your assigned team.</p></div>
					<button type="button" onClick={() => { setError(""); setIsCreating((open) => !open); }} className="flex h-10 items-center gap-2 rounded-lg bg-[#171717] px-4 text-sm font-medium text-white hover:bg-[#333]">{isCreating ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{isCreating ? "Close" : "New shared draft"}</button>
				</div>

				{error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-xs text-red-700">{error}</p>}
				{isCreating && <form onSubmit={(event) => { event.preventDefault(); createDraft.mutate(); }} className="mt-6 rounded-2xl border border-[#dce5f2] bg-[#f8fbff] p-5 md:p-6">
					<div className="mb-4"><h2 className="text-sm font-semibold text-[#202124]">Create a shared draft</h2><p className="mt-1 text-xs text-[#687078]">Everyone with access to this mailbox can use this template.</p></div>
					<div className="grid gap-3 md:grid-cols-2">
						<label className="block"><span className="mb-1 block text-xs font-medium text-[#343a40]">Template name</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="New client introduction" className="h-10 w-full rounded-lg border border-[#dadce0] bg-white px-3 text-sm outline-none focus:border-[#315f9f]" /></label>
						<label className="block"><span className="mb-1 block text-xs font-medium text-[#343a40]">To</span><input value={to} onChange={(event) => setTo(event.target.value)} placeholder="Optional recipient" className="h-10 w-full rounded-lg border border-[#dadce0] bg-white px-3 text-sm outline-none focus:border-[#315f9f]" /></label>
						<label className="block"><span className="mb-1 block text-xs font-medium text-[#343a40]">CC</span><input value={cc} onChange={(event) => setCc(event.target.value)} placeholder="Optional" className="h-10 w-full rounded-lg border border-[#dadce0] bg-white px-3 text-sm outline-none focus:border-[#315f9f]" /></label>
						<label className="block"><span className="mb-1 block text-xs font-medium text-[#343a40]">BCC</span><input value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder="Optional" className="h-10 w-full rounded-lg border border-[#dadce0] bg-white px-3 text-sm outline-none focus:border-[#315f9f]" /></label>
						<label className="block md:col-span-2"><span className="mb-1 block text-xs font-medium text-[#343a40]">Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Optional subject" className="h-10 w-full rounded-lg border border-[#dadce0] bg-white px-3 text-sm outline-none focus:border-[#315f9f]" /></label>
						<label className="block md:col-span-2"><span className="mb-1 block text-xs font-medium text-[#343a40]">Message</span><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} className="w-full rounded-lg border border-[#dadce0] bg-white px-3 py-2 text-sm outline-none focus:border-[#315f9f]" /></label>
					</div>
					<div className="mt-4 flex justify-end"><button type="submit" disabled={!name.trim() || createDraft.isPending} className="rounded-lg bg-[#171717] px-4 py-2 text-xs font-medium text-white hover:bg-[#333333] disabled:opacity-50">{createDraft.isPending ? "Saving…" : "Save shared draft"}</button></div>
				</form>}

				<section className="mt-8">
					<div className="mb-3 flex items-center gap-2"><Users className="h-4 w-4 text-[#315f9f]"/><div><h2 className="text-sm font-semibold text-[#202124]">Common drafts</h2><p className="text-[11px] text-[#687078]">Available to people assigned to this mailbox</p></div><span className="ml-auto rounded-full bg-[#f1f3f4] px-2.5 py-1 text-[11px] text-[#5f6368]">{sharedDrafts.length}</span></div>
					{sharedLoading ? <div className="h-20 animate-pulse rounded-xl bg-[#f3f4f5]" /> : sharedDrafts.length ? <div className="overflow-hidden rounded-xl border border-[#e5e5e5]">{sharedDrafts.map((draft) => <div key={draft.id} className="flex items-start gap-3 border-b border-[#e5e5e5] px-4 py-4 last:border-b-0 md:px-5"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eaf1fb] text-[#315f9f]"><FileText className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[#202124]">{draft.name}</p><p className="mt-1 truncate text-xs text-[#5f6368]">{draft.subject || "No subject"}{draft.to ? ` · To ${draft.to}` : ""}</p><p className="mt-1 line-clamp-2 text-xs text-[#777f87]">{getSnippetText(draft.body, 180)}</p><p className="mt-2 text-[10px] text-[#8a9096]">Updated {formatListDate(draft.updatedAt)}</p></div><button type="button" onClick={() => startCompose({ mode: "new", to: draft.to, subject: draft.subject, body: draft.body })} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#171717] px-3 py-2 text-xs font-medium text-white hover:bg-[#333333]"><Send className="h-3.5 w-3.5"/>Use</button><button type="button" aria-label={`Delete ${draft.name}`} onClick={() => deleteDraft.mutate(draft.id)} className="rounded-lg p-2 text-[#8a9096] hover:bg-red-50 hover:text-red-700"><Trash2 className="h-4 w-4"/></button></div>)}</div> : <div className="rounded-xl border border-dashed border-[#d7dbe0] px-5 py-8 text-center"><p className="text-sm font-medium text-[#202124]">No common drafts</p><p className="mt-1 text-xs text-[#687078]">Create a reusable email template for your team.</p></div>}
				</section>

				<section className="mt-8">
					<div className="mb-3 flex items-center gap-2"><FileText className="h-4 w-4 text-[#5f6368]"/><div><h2 className="text-sm font-semibold text-[#202124]">My drafts</h2><p className="text-[11px] text-[#687078]">Private to this address</p></div><span className="ml-auto rounded-full bg-[#f1f3f4] px-2.5 py-1 text-[11px] text-[#5f6368]">{personalDrafts.length}</span></div>
					{personalLoading ? <div className="h-20 animate-pulse rounded-xl bg-[#f3f4f5]" /> : personalDrafts.length ? <div className="overflow-hidden rounded-xl border border-[#e5e5e5]">{personalDrafts.map((draft) => <Link key={draft.id} to={`/mailbox/${mailboxId}/emails/draft?open=${encodeURIComponent(draft.id)}`} className="flex items-center gap-3 border-b border-[#e5e5e5] px-4 py-4 no-underline last:border-b-0 hover:bg-[#f8f9fa] md:px-5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[#202124]">{draft.subject || "(no subject)"}</p><p className="mt-1 truncate text-xs text-[#5f6368]">To: {draft.recipient || "No recipient yet"}</p><p className="mt-1 line-clamp-2 text-xs text-[#777f87]">{getSnippetText(draft.snippet, 160)}</p></div><span className="shrink-0 text-xs text-[#747b83]">{formatListDate(draft.date)}</span></Link>)}</div> : <div className="rounded-xl border border-dashed border-[#d7dbe0] px-5 py-8 text-center"><p className="text-sm font-medium text-[#202124]">No private drafts</p><p className="mt-1 text-xs text-[#687078]">Unsaved work you save from Compose will appear here.</p></div>}
				</section>
			</div>
		</div>
	);
}
