import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import api from "~/services/api";

const SCOPE_OPTIONS = [
	{ id: "mail:read", label: "Read mail", detail: "Read messages, folders, search results, and attachments." },
	{ id: "mail:draft", label: "Create drafts", detail: "Save draft messages in this mailbox." },
	{ id: "mail:send", label: "Send mail", detail: "Send new messages and reply or forward through Zoho." },
] as const;

type Scope = (typeof SCOPE_OPTIONS)[number]["id"];
type APIKeyRecord = {
	id: string; name: string; created_by: string; scopes: Scope[]; created_at: string;
	expires_at: string; last_used_at: string | null; revoked_at: string | null;
};

function dateLabel(value: string | null) {
	if (!value) return "Never";
	return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function ApiAccessRoute() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<Scope[]>(["mail:read"]);
	const [expiresInDays, setExpiresInDays] = useState(30);
	const [createdToken, setCreatedToken] = useState("");
	const [error, setError] = useState("");
	const { data: keys = [], isLoading } = useQuery({
		queryKey: ["api-keys", mailboxId],
		queryFn: () => api.listAPIKeys(mailboxId) as Promise<APIKeyRecord[]>,
		enabled: !!mailboxId,
	});
	const createKey = useMutation({
		mutationFn: () => api.createAPIKey(mailboxId, { name: name.trim(), scopes, expiresInDays }),
		onSuccess: (result) => {
			setCreatedToken(result.token);
			setName("");
			setError("");
			queryClient.invalidateQueries({ queryKey: ["api-keys", mailboxId] });
		},
		onError: (cause) => setError((cause as Error).message),
	});
	const revokeKey = useMutation({
		mutationFn: (keyId: string) => api.revokeAPIKey(mailboxId, keyId),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys", mailboxId] }),
		onError: (cause) => setError((cause as Error).message),
	});
	const activeKeys = keys.filter((key) => !key.revoked_at && Date.parse(key.expires_at) > Date.now());

	const toggleScope = (scope: Scope) => setScopes((current) => current.includes(scope)
		? current.filter((value) => value !== scope)
		: [...current, scope]);

	return (
		<div className="h-full overflow-y-auto bg-white px-5 py-7 md:px-9 md:py-9">
			<div className="mx-auto max-w-4xl">
				<div className="flex items-start gap-3 border-b border-[#e5e5e5] pb-6">
					<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eaf1fb] text-[#315f9f]"><KeyRound className="h-5 w-5" /></div>
					<div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b7280]">Developer tools</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-[#202124]">API access</h1><p className="mt-1 text-sm text-[#687078]">Create scoped credentials for integrations with this Zoho mailbox.</p></div>
				</div>

				{createdToken && <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
					<div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-emerald-900">API key created. Copy it now.</p><p className="mt-1 text-xs text-emerald-800">The full token is shown once. Store it in your integration’s secret manager.</p><code className="mt-3 block break-all rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs text-[#202124]">{createdToken}</code></div><button type="button" onClick={() => navigator.clipboard?.writeText(createdToken)} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-100"><Copy className="h-3.5 w-3.5" />Copy</button><button type="button" onClick={() => setCreatedToken("")} aria-label="Dismiss token" className="rounded px-1 text-emerald-800">×</button></div>
				</div>}

				<section className="mt-7 rounded-2xl border border-[#e5e5e5] p-5 md:p-6">
					<div className="mb-5"><h2 className="text-base font-semibold text-[#202124]">Create an API key</h2><p className="mt-1 text-xs text-[#687078]">Keys are limited to 10 per mailbox and expire automatically.</p></div>
					<form onSubmit={(event) => { event.preventDefault(); setError(""); createKey.mutate(); }} className="space-y-5">
						<label className="block"><span className="mb-1.5 block text-xs font-medium text-[#343a40]">Key name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. CRM sync" required className="h-10 w-full rounded-lg border border-[#dadce0] px-3 text-sm outline-none focus:border-[#315f9f] focus:ring-2 focus:ring-[#315f9f]/10" /></label>
						<div><p className="mb-2 text-xs font-medium text-[#343a40]">Permissions</p><div className="grid gap-2 md:grid-cols-3">{SCOPE_OPTIONS.map((option) => <label key={option.id} className={`cursor-pointer rounded-xl border p-3 transition-colors ${scopes.includes(option.id) ? "border-[#315f9f] bg-[#f5f8fd]" : "border-[#e5e5e5] hover:bg-[#fafafa]"}`}><span className="flex items-center gap-2 text-sm font-medium text-[#202124]"><input type="checkbox" checked={scopes.includes(option.id)} onChange={() => toggleScope(option.id)} className="accent-[#315f9f]" />{option.label}</span><span className="mt-1.5 block pl-6 text-[11px] leading-relaxed text-[#687078]">{option.detail}</span></label>)}</div></div>
						<div className="flex flex-wrap items-end gap-3"><label className="block"><span className="mb-1.5 block text-xs font-medium text-[#343a40]">Expires in</span><select value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} className="h-10 rounded-lg border border-[#dadce0] bg-white px-3 text-sm"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label><button type="submit" disabled={!name.trim() || scopes.length === 0 || createKey.isPending} className="flex h-10 items-center gap-2 rounded-lg bg-[#171717] px-4 text-sm font-medium text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" />{createKey.isPending ? "Creating…" : "Create key"}</button>{error && <p role="alert" className="text-xs text-red-700">{error}</p>}</div>
					</form>
				</section>

				<section className="mt-8">
					<div className="mb-3 flex items-center justify-between"><div><h2 className="text-base font-semibold text-[#202124]">Keys for this mailbox</h2><p className="mt-1 text-xs text-[#687078]">{activeKeys.length} active · {keys.length} total</p></div></div>
					{isLoading ? <div className="h-24 animate-pulse rounded-xl bg-[#f3f4f5]" /> : keys.length ? <div className="overflow-hidden rounded-xl border border-[#e5e5e5]">{keys.map((key) => {
						const active = !key.revoked_at && Date.parse(key.expires_at) > Date.now();
						return <div key={key.id} className="flex flex-wrap items-center gap-3 border-b border-[#e5e5e5] px-4 py-4 last:border-b-0 md:px-5"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f1f3f4] text-[#5f6368]"><KeyRound className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium text-[#202124]">{key.name}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${active ? "bg-emerald-50 text-emerald-700" : "bg-[#f1f3f4] text-[#687078]"}`}>{active ? "Active" : key.revoked_at ? "Revoked" : "Expired"}</span></div><div className="mt-1 text-[11px] text-[#687078]">{key.scopes.join(" · ")} · expires {dateLabel(key.expires_at)} · last used {dateLabel(key.last_used_at)}</div></div>{active && <button type="button" onClick={() => revokeKey.mutate(key.id)} disabled={revokeKey.isPending} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />Revoke</button>}</div>;
					})}</div> : <div className="rounded-xl border border-dashed border-[#d7dbe0] px-5 py-10 text-center"><KeyRound className="mx-auto h-7 w-7 text-[#9aa0a6]" /><p className="mt-2 text-sm font-medium text-[#202124]">No API keys yet</p><p className="mt-1 text-xs text-[#687078]">Create a key above to connect an integration.</p></div>}
				</section>

				<section className="mt-8 rounded-2xl bg-[#f6f7f8] p-5 md:p-6"><h2 className="text-sm font-semibold text-[#202124]">Using a key</h2><p className="mt-1 text-xs text-[#687078]">Send the token in an Authorization header. Every key is limited to this mailbox and its selected permissions.</p><pre className="mt-3 overflow-x-auto rounded-lg bg-[#202124] p-4 text-xs leading-relaxed text-[#f4f4f4]">{`curl https://email.nakmedia.co/api/v1/mailboxes/${mailboxId}/emails \\\n  -H "Authorization: Bearer $NAK_MAIL_API_KEY"`}</pre><p className="mt-3 text-[11px] text-[#687078]">Read keys can list and search mail. Draft keys can save drafts. Send keys can send, reply, and forward through Zoho.</p></section>
			</div>
		</div>
	);
}
