import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api from "~/services/api";
import { useMe } from "~/queries/access";
import type { AutoCampaign, AutoImportResult, AutoPreview } from "~/types/automation";

const card = "rounded-lg border border-kumo-line bg-kumo-base p-4";
const field = "mt-1 w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm text-kumo-default";
const when = (ts: number) => new Date(ts).toLocaleString();
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const STATUS_TONE: Record<string, string> = { active: "bg-green-100 text-green-700", paused: "bg-amber-100 text-amber-700", draft: "bg-gray-100 text-gray-700", stopped: "bg-red-100 text-red-700" };

function useRefresh() {
	const qc = useQueryClient();
	return () => qc.invalidateQueries({ queryKey: ["auto"] });
}

export default function AutomationRoute() {
	const { data: me } = useMe();
	const [openId, setOpenId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	if (me && me.role !== "admin") return <div className="p-6 text-sm text-kumo-subtle">Automation is available to admins only.</div>;
	return (
		<div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
			{creating ? <CampaignForm onDone={(id) => { setCreating(false); if (id) setOpenId(id); }} />
				: openId ? <CampaignDetail id={openId} onBack={() => setOpenId(null)} />
				: <Overview onOpen={setOpenId} onNew={() => setCreating(true)} />}
		</div>
	);
}

// ---------------------------------------------------------------- overview
function Overview({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
	const toast = useKumoToastManager();
	const refresh = useRefresh();
	const { data, isLoading, isError, error } = useQuery({ queryKey: ["auto", "overview"], queryFn: () => api.autoOverview(), refetchInterval: 10_000 });
	const master = useMutation({ mutationFn: (on: boolean) => api.autoMaster(on), onSuccess: refresh, onError: (e) => toast.add({ title: msg(e), variant: "error" }) });
	const [email, setEmail] = useState("");
	if (isLoading) return <div className="flex justify-center py-10"><Loader /></div>;
	if (isError || !data) return <div className={`${card} text-sm text-kumo-danger`}>{msg(error)}</div>;
	const on = data.settings.masterEnabled;

	return (
		<>
			<div className={`${card} flex items-center justify-between gap-3 ${on ? "border-green-300" : ""}`}>
				<div className="min-w-0">
					<div className="text-sm font-semibold text-kumo-default">Automation engine: {on ? "ON" : "OFF"}</div>
					<p className="text-xs text-kumo-subtle">
						{on ? "Active campaigns can send within their limits. STOP ALL blocks every send immediately." : "Nothing is sent while this is off. Drafting and sending both stop."}
					</p>
					{data.settings.changedAt > 0 && <p className="text-xs text-kumo-subtle">Last changed by {data.settings.changedBy} · {when(data.settings.changedAt)}</p>}
				</div>
				<Button variant={on ? "destructive" : "primary"} loading={master.isPending}
					onClick={() => { if (on || window.confirm("Switch the engine ON? Active campaigns may send emails within their limits.")) master.mutate(!on); }}>
					{on ? "STOP ALL" : "Switch ON"}
				</Button>
			</div>

			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold text-kumo-default">Campaigns</h1>
				<Button variant="primary" onClick={onNew}>New campaign</Button>
			</div>
			<p className="text-xs text-kumo-subtle">Sent today (all campaigns): {data.sentToday} · writer model: {data.writer} · opt-outs on file: {data.suppression}</p>

			{data.campaigns.length === 0 && <div className={`${card} text-sm text-kumo-subtle`}>No campaigns yet. Create one, import leads from a spreadsheet, and check the previews before switching anything on.</div>}
			{data.campaigns.map((c) => (
				<button key={c.id} type="button" onClick={() => onOpen(c.id)} className={`${card} block w-full text-left hover:bg-kumo-tint`}>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-medium text-kumo-default break-words">{c.name}</span>
						<span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[c.status]}`}>{c.status}</span>
					</div>
					<div className="mt-1 text-xs text-kumo-subtle break-all">{c.sender_alias} · {c.mode === "auto_send" ? (c.permissionActive ? "auto-send (permitted)" : "auto-send (no permission)") : "draft only"}</div>
					<div className="mt-1 text-xs text-kumo-subtle">{c.totalLeads} leads · {c.sent} sent ({c.sentToday} today) · {c.pendingApproval} waiting for approval</div>
					{c.paused_reason && <div className="mt-1 text-xs text-amber-700">{c.paused_reason}</div>}
				</button>
			))}

			<div className={card}>
				<div className="text-sm font-medium text-kumo-default mb-2">Never contact (opt-out list)</div>
				<form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { await api.autoSuppress(email.trim()); toast.add({ title: "Added" }); setEmail(""); refresh(); } catch (err) { toast.add({ title: msg(err), variant: "error" }); } }}>
					<input className={field + " !mt-0"} type="email" placeholder="person@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
					<Button type="submit" variant="secondary">Add</Button>
				</form>
			</div>
		</>
	);
}

// ---------------------------------------------------------------- campaign form
const DAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7]] as const;

function CampaignForm({ initial, onDone }: { initial?: AutoCampaign; onDone: (id?: string) => void }) {
	const toast = useKumoToastManager();
	const refresh = useRefresh();
	const senders = useQuery({ queryKey: ["auto", "senders"], queryFn: () => api.autoSenders(), staleTime: 60_000 });
	const [f, setF] = useState({
		name: initial?.name ?? "", sender_alias: initial?.sender_alias ?? "", sender_name: initial?.sender_name ?? "", company: initial?.company ?? "",
		postal_address: initial?.postal_address ?? "", brief: initial?.brief ?? "", language: initial?.language ?? "English", mode: initial?.mode ?? "draft_only",
		daily_cap: initial?.daily_cap ?? 20, min_gap_min: initial?.min_gap_min ?? 8, max_gap_min: initial?.max_gap_min ?? 20,
		window_start: initial?.window_start ?? 10, window_end: initial?.window_end ?? 17, max_followups: initial?.max_followups ?? 2,
		followup_gap_days: initial?.followup_gap_days ?? 4, allow_links: !!initial?.allow_links,
		days: (initial?.days ?? "1,2,3,4,5").split(",").map(Number),
	});
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
	const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value));

	const save = async (e: React.FormEvent) => {
		e.preventDefault(); setErr(null); setBusy(true);
		try {
			if (initial) { await api.autoUpdate(initial.id, f); refresh(); toast.add({ title: "Saved" }); onDone(initial.id); }
			else { const r = await api.autoCreate(f); refresh(); toast.add({ title: "Campaign created" }); onDone(r.id); }
		} catch (x) { setErr(msg(x)); } finally { setBusy(false); }
	};

	return (
		<form onSubmit={save} className="space-y-4">
			<div className="flex items-center justify-between"><h1 className="text-lg font-semibold text-kumo-default">{initial ? "Edit campaign" : "New campaign"}</h1><Button type="button" variant="ghost" onClick={() => onDone(initial?.id)}>Cancel</Button></div>
			<div className={`${card} space-y-3`}>
				<Input label="Campaign name" value={f.name} onChange={(e) => set("name", e.target.value)} required />
				<label className="block text-sm font-medium text-kumo-default">Send from (alias)
					{senders.data?.senders.length
						? <select className={field} value={f.sender_alias} onChange={(e) => set("sender_alias", e.target.value)} required>
							<option value="">Choose an alias…</option>
							{senders.data.senders.map((s) => <option key={s.alias} value={s.alias}>{s.alias} (today {s.sentToday}/{s.rampCap})</option>)}
						</select>
						: <input className={field} type="email" value={f.sender_alias} onChange={(e) => set("sender_alias", e.target.value)} placeholder="name@yourdomain.com" required />}
				</label>
				<p className="text-xs text-kumo-subtle">admin@, connect@, support@, sales@ and noreply@ can never be used for cold mail.{senders.data?.error ? ` (Could not load aliases: ${senders.data.error})` : ""}</p>
				<Input label="Sender name (a real person)" value={f.sender_name} onChange={(e) => set("sender_name", e.target.value)} required />
				<Input label="Company" value={f.company} onChange={(e) => set("company", e.target.value)} />
				<Input label="Postal address (shown in every email)" value={f.postal_address} onChange={(e) => set("postal_address", e.target.value)} />
				<label className="block text-sm font-medium text-kumo-default">What you offer (iRIS writes from this)
					<textarea className={field} rows={4} value={f.brief} onChange={(e) => set("brief", e.target.value)} maxLength={3000} placeholder="Who you are, what you offer, who it is for, proof or typical results. Be factual: iRIS will not invent anything." required />
				</label>
				<Input label="Language" value={f.language} onChange={(e) => set("language", e.target.value)} />
			</div>

			<div className={`${card} space-y-3`}>
				<label className="block text-sm font-medium text-kumo-default">Mode
					<select className={field} value={f.mode} onChange={(e) => set("mode", e.target.value)}>
						<option value="draft_only">Draft only: I approve every email</option>
						<option value="auto_send">Auto-send: only after I grant permission</option>
					</select>
				</label>
				<div className="grid grid-cols-2 gap-3">
					<label className="text-sm font-medium text-kumo-default">Daily cap<input className={field} type="number" min={1} max={50} value={f.daily_cap} onChange={num("daily_cap")} /></label>
					<label className="text-sm font-medium text-kumo-default">Follow-ups (0-3)<input className={field} type="number" min={0} max={3} value={f.max_followups} onChange={num("max_followups")} /></label>
					<label className="text-sm font-medium text-kumo-default">Min gap (minutes)<input className={field} type="number" min={4} value={f.min_gap_min} onChange={num("min_gap_min")} /></label>
					<label className="text-sm font-medium text-kumo-default">Max gap (minutes)<input className={field} type="number" min={4} value={f.max_gap_min} onChange={num("max_gap_min")} /></label>
					<label className="text-sm font-medium text-kumo-default">Send from hour<input className={field} type="number" min={0} max={23} value={f.window_start} onChange={num("window_start")} /></label>
					<label className="text-sm font-medium text-kumo-default">Until hour<input className={field} type="number" min={1} max={24} value={f.window_end} onChange={num("window_end")} /></label>
					<label className="text-sm font-medium text-kumo-default">Days between follow-ups<input className={field} type="number" min={2} max={30} value={f.followup_gap_days} onChange={num("followup_gap_days")} /></label>
				</div>
				<div className="flex flex-wrap gap-3 text-sm text-kumo-default">
					{DAYS.map(([n, d]) => (
						<label key={d} className="flex items-center gap-1"><input type="checkbox" checked={f.days.includes(d)} onChange={(e) => set("days", e.target.checked ? [...f.days, d] : f.days.filter((x) => x !== d))} />{n}</label>
					))}
				</div>
				<label className="flex items-center gap-2 text-sm text-kumo-default"><input type="checkbox" checked={f.allow_links} onChange={(e) => set("allow_links", e.target.checked)} />Allow one link per email (more spam risk; off is safer)</label>
				<p className="text-xs text-kumo-subtle">New aliases are held back by a warm-up ramp (5/day, rising over 3 weeks) whatever the daily cap. Gaps are randomised between min and max and never below 4 minutes.</p>
			</div>
			{err && <div className="text-sm text-kumo-danger" role="alert">{err}</div>}
			<Button type="submit" variant="primary" loading={busy}>{initial ? "Save changes" : "Create campaign"}</Button>
		</form>
	);
}

// ---------------------------------------------------------------- campaign detail
type Tab = "overview" | "leads" | "approvals" | "activity";

function CampaignDetail({ id, onBack }: { id: string; onBack: () => void }) {
	const [tab, setTab] = useState<Tab>("overview");
	const [editing, setEditing] = useState(false);
	const { data, isLoading, isError, error } = useQuery({ queryKey: ["auto", "campaign", id], queryFn: () => api.autoGet(id), refetchInterval: 10_000 });
	if (isLoading) return <div className="flex justify-center py-10"><Loader /></div>;
	if (isError || !data) return <div className={`${card} text-sm text-kumo-danger`}>{msg(error)}</div>;
	const c = data.campaign;
	if (editing) return <CampaignForm initial={c} onDone={() => setEditing(false)} />;
	const pending = data.stats.pendingApproval ?? 0;

	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<Button variant="ghost" onClick={onBack}>← Campaigns</Button>
				<span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[c.status]}`}>{c.status}</span>
			</div>
			<div><h1 className="text-lg font-semibold text-kumo-default break-words">{c.name}</h1><p className="text-xs text-kumo-subtle break-all">{c.sender_alias} · today {data.sender.sentToday}/{data.sender.rampCap} (warm-up day {data.sender.ageDays + 1})</p></div>
			{c.paused_reason && c.status === "paused" && <div className={`${card} text-sm text-amber-700`}>Paused: {c.paused_reason}</div>}
			<div className="flex flex-wrap gap-2">
				{(["overview", "leads", "approvals", "activity"] as Tab[]).map((t) => (
					<Button key={t} size="sm" variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>{t === "approvals" ? `Approvals${pending ? ` (${pending})` : ""}` : t[0].toUpperCase() + t.slice(1)}</Button>
				))}
			</div>
			{tab === "overview" && <OverviewTab c={c} stats={data.stats} onEdit={() => setEditing(true)} />}
			{tab === "leads" && <LeadsTab id={id} />}
			{tab === "approvals" && <ApprovalsTab id={id} />}
			{tab === "activity" && <div className={`${card} space-y-1`}>{data.events.length === 0 ? <p className="text-sm text-kumo-subtle">Nothing yet.</p> : data.events.map((e, i) => <div key={i} className="text-xs text-kumo-default"><span className="text-kumo-subtle">{when(e.ts)}</span> · {e.type} · {e.detail}</div>)}</div>}
		</>
	);
}

function OverviewTab({ c, stats, onEdit }: { c: AutoCampaign; stats: Record<string, any>; onEdit: () => void }) {
	const toast = useKumoToastManager();
	const refresh = useRefresh();
	const [hours, setHours] = useState(24);
	const ready = useQuery({ queryKey: ["auto", "ready", c.id, c.status, c.confirmed_legit, stats.totalLeads], queryFn: () => api.autoReadiness(c.id), staleTime: 15_000 });
	const act = useMutation({
		mutationFn: (fn: () => Promise<unknown>) => fn(),
		onSuccess: refresh,
		onError: (e: any) => toast.add({ title: e?.message ?? "Failed", variant: "error" }),
	});
	const counts = stats.leadCounts ?? {};

	return (
		<>
			<div className={`${card} text-sm text-kumo-default space-y-1`}>
				<div>Leads: {stats.totalLeads ?? 0} · sent {stats.sent ?? 0} · today {stats.sentToday ?? 0}</div>
				<div className="text-xs text-kumo-subtle">{Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No leads yet. Import a spreadsheet in the Leads tab."}</div>
				<div className="text-xs text-kumo-subtle">Window {c.window_start}:00-{c.window_end}:00 ({c.tz}) · gap {c.min_gap_min}-{c.max_gap_min} min · cap {c.daily_cap}/day · {c.max_followups} follow-ups every ~{c.followup_gap_days} days</div>
				{c.status !== "active" && <Button size="sm" variant="secondary" onClick={onEdit}>Edit settings</Button>}
			</div>

			<div className={`${card} space-y-2`}>
				<div className="text-sm font-medium text-kumo-default">Before it can start</div>
				{ready.isLoading ? <Loader size="sm" /> : ready.data && (
					<>
						{ready.data.errors.map((e) => <div key={e} className="text-xs text-kumo-danger">✗ {e}</div>)}
						{ready.data.warnings.map((e) => <div key={e} className="text-xs text-amber-700">! {e}</div>)}
						{ready.data.ok && <div className="text-xs text-green-700">✓ All safety checks pass (SPF, DMARC, alias, address, contacts).</div>}
					</>
				)}
				{!c.confirmed_legit && (
					<label className="flex items-start gap-2 text-xs text-kumo-default"><input type="checkbox" onChange={(e) => e.target.checked && act.mutate(() => api.autoConfirm(c.id))} />
						<span>I confirm these are business contacts I may legitimately email (not a scraped or bought list) and I will honour every opt-out.</span></label>
				)}
			</div>

			<div className="flex flex-wrap gap-2">
				{c.status !== "active" && c.status !== "stopped" && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(() => api.autoActivate(c.id))}>{c.status === "paused" ? "Resume" : "Start campaign"}</Button>}
				{c.status === "active" && <Button variant="secondary" onClick={() => act.mutate(() => api.autoPause(c.id))}>Pause</Button>}
				{c.status !== "stopped" && <Button variant="destructive" onClick={() => window.confirm("Stop this campaign for good? Pending drafts are cancelled.") && act.mutate(() => api.autoStop(c.id))}>Stop</Button>}
			</div>

			{c.mode === "auto_send" && (
				<div className={`${card} space-y-2`}>
					<div className="text-sm font-medium text-kumo-default">Auto-send permission</div>
					{stats.permissionActive
						? <><p className="text-xs text-green-700">Granted until {when(c.permission_until!)}. iRIS may send within the limits above.</p><Button size="sm" variant="destructive" onClick={() => act.mutate(() => api.autoRevoke(c.id))}>Revoke permission</Button></>
						: <>
							<p className="text-xs text-kumo-subtle">Without permission nothing is sent automatically. Permission expires on its own.</p>
							<div className="flex items-center gap-2">
								<select className={field + " !mt-0 !w-auto"} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
									<option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option><option value={720}>30 days</option>
								</select>
								<Button size="sm" variant="primary" onClick={() => act.mutate(() => api.autoGrant(c.id, hours))}>Grant permission</Button>
							</div>
						</>}
				</div>
			)}
		</>
	);
}

function LeadsTab({ id }: { id: string }) {
	const toast = useKumoToastManager();
	const refresh = useRefresh();
	const [status, setStatus] = useState("");
	const [sheet, setSheet] = useState("");
	const [csv, setCsv] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<AutoImportResult | null>(null);
	const [previews, setPreviews] = useState<AutoPreview[] | null>(null);
	const [prevBusy, setPrevBusy] = useState(false);
	const leads = useQuery({ queryKey: ["auto", "leads", id, status], queryFn: () => api.autoLeads(id, status || undefined) });
	const analysis = useQuery({ queryKey: ["auto", "analysis", id, leads.data?.total], queryFn: () => api.autoAnalysis(id) });

	const doImport = async (body: { csv?: string; sheetUrl?: string }) => {
		setBusy(true); setResult(null);
		try { setResult(await api.autoImport(id, body)); refresh(); setCsv(""); setSheet(""); } catch (e) { toast.add({ title: msg(e), variant: "error" }); } finally { setBusy(false); }
	};
	const onFile = async (file?: File) => {
		if (!file) return;
		try {
			if (/\.(xlsx|xls)$/i.test(file.name)) {
				const XLSX = await import("xlsx");
				const wb = XLSX.read(await file.arrayBuffer());
				await doImport({ csv: XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]) });
			} else await doImport({ csv: await file.text() });
		} catch (e) { toast.add({ title: msg(e), variant: "error" }); }
	};

	return (
		<>
			<div className={`${card} space-y-3`}>
				<div className="text-sm font-medium text-kumo-default">Import leads</div>
				<p className="text-xs text-kumo-subtle">Needs an <b>email</b> column. Optional: name, company, role, website, notes (the more real context in notes, the more personal each email). Other columns are passed to iRIS as extra context.</p>
				<input type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm text-kumo-default" />
				<div className="flex gap-2">
					<input className={field + " !mt-0"} placeholder="Google Sheets link (shared as 'Anyone with the link can view')" value={sheet} onChange={(e) => setSheet(e.target.value)} />
					<Button variant="secondary" disabled={!sheet.trim()} loading={busy} onClick={() => doImport({ sheetUrl: sheet.trim() })}>Import</Button>
				</div>
				<details><summary className="cursor-pointer text-xs text-kumo-subtle">Or paste CSV text</summary>
					<textarea className={field} rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"email,name,company,notes\nsam@clinic.in,Sam,Rao Clinic,runs a dental clinic"} />
					<Button size="sm" variant="secondary" disabled={!csv.trim()} loading={busy} onClick={() => doImport({ csv })}>Import pasted CSV</Button>
				</details>
				{result && <div className="text-xs text-kumo-default">Added {result.added} · duplicates {result.duplicates} · opted-out {result.suppressed} · invalid {result.invalid.length}{result.capped ? ` · over limit ${result.capped}` : ""}
					{result.invalid.slice(0, 5).map((i) => <div key={i.email} className="text-amber-700">{i.email || "(empty)"}: {i.reason}</div>)}</div>}
			</div>

			{analysis.data && analysis.data.total > 0 && (
				<div className={`${card} text-xs text-kumo-default space-y-1`}>
					<div className="text-sm font-medium">Sheet analysis</div>
					<div>{analysis.data.total} leads · {analysis.data.withName} with name · {analysis.data.withCompany} with company · {analysis.data.withNotes} with notes</div>
					<div className="text-kumo-subtle">Top domains: {analysis.data.topDomains.map((d) => `${d.domain} (${d.count})`).join(", ")}</div>
					{analysis.data.tip && <div className="text-amber-700">{analysis.data.tip}</div>}
					<Button size="sm" variant="secondary" loading={prevBusy} onClick={async () => { setPrevBusy(true); try { setPreviews((await api.autoPreview(id)).previews); } catch (e) { toast.add({ title: msg(e), variant: "error" }); } finally { setPrevBusy(false); } }}>Preview 3 emails (nothing is sent)</Button>
				</div>
			)}
			{previews && previews.map((p) => (
				<div key={p.to} className={`${card} text-sm`}>
					<div className="text-xs text-kumo-subtle">To: {p.to}{p.words ? ` · ${p.words} words` : ""}</div>
					{p.subject && <div className="font-medium text-kumo-default">{p.subject}</div>}
					{p.text && <div className="whitespace-pre-wrap text-kumo-default">{p.text}</div>}
					{(p.problems ?? []).map((x) => <div key={x} className="text-xs text-kumo-danger">✗ {x}</div>)}
				</div>
			))}

			<div className={`${card} space-y-2`}>
				<div className="flex items-center justify-between">
					<span className="text-sm font-medium text-kumo-default">Leads ({leads.data?.total ?? 0})</span>
					<select className={field + " !mt-0 !w-auto"} value={status} onChange={(e) => setStatus(e.target.value)}>
						<option value="">All</option>
						{["new", "awaiting_approval", "contacted", "replied", "completed", "bounced", "unsubscribed", "invalid", "skipped"].map((s) => <option key={s} value={s}>{s}</option>)}
					</select>
				</div>
				{leads.data?.leads.map((l) => (
					<div key={l.id} className="flex items-center justify-between gap-2 border-t border-kumo-line pt-1 text-xs">
						<span className="min-w-0 break-all text-kumo-default">{l.name ? `${l.name} · ` : ""}{l.email}</span>
						<Badge variant="secondary">{l.status}{l.step ? ` · ${l.step}` : ""}</Badge>
					</div>
				))}
			</div>
		</>
	);
}

function ApprovalsTab({ id }: { id: string }) {
	const toast = useKumoToastManager();
	const refresh = useRefresh();
	const q = useQuery({ queryKey: ["auto", "approvals", id], queryFn: () => api.autoApprovals(id), refetchInterval: 10_000 });
	if (q.isLoading) return <Loader />;
	if (!q.data?.length) return <div className={`${card} text-sm text-kumo-subtle`}>No drafts waiting. In draft-only mode iRIS writes up to 10 drafts at a time for you to approve.</div>;
	return <>{q.data.map((m) => <Draft key={m.id} m={m} onChange={() => { refresh(); void q.refetch(); }} toast={toast} />)}</>;
}

function Draft({ m, onChange, toast }: { m: { id: string; lead_id: string; to_email: string; name: string | null; company: string | null; step: number; subject: string; body: string }; onChange: () => void; toast: ReturnType<typeof useKumoToastManager> }) {
	const [subject, setSubject] = useState(m.subject);
	const [body, setBody] = useState(m.body);
	const [busy, setBusy] = useState(false);
	const run = async (fn: () => Promise<unknown>, ok: string) => {
		setBusy(true);
		try { await fn(); toast.add({ title: ok }); onChange(); } catch (e) { toast.add({ title: msg(e), variant: "error" }); } finally { setBusy(false); }
	};
	const edited = subject !== m.subject || body !== m.body;
	return (
		<div className={`${card} space-y-2`}>
			<div className="text-xs text-kumo-subtle break-all">To: {m.name ? `${m.name} · ` : ""}{m.to_email}{m.company ? ` · ${m.company}` : ""} · {m.step === 0 ? "first email" : `follow-up ${m.step}`}</div>
			<input className={field + " !mt-0"} value={subject} onChange={(e) => setSubject(e.target.value)} />
			<textarea className={field + " !mt-0"} rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
			<p className="text-xs text-kumo-subtle">Sign-off, your name, company, postal address and the opt-out line are added automatically. Edits must still pass the same spam rules.</p>
			<div className="flex flex-wrap gap-2">
				<Button size="sm" variant="primary" loading={busy} onClick={() => run(() => api.autoApprove(m.id, edited ? { subject, body } : undefined), "Approved. It sends when the next slot opens.")}>Approve</Button>
				<Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api.autoReject(m.id), "Rejected. iRIS will write a new one.")}>Reject & rewrite</Button>
				<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api.autoSkip(m.lead_id), "Lead skipped")}>Skip this lead</Button>
			</div>
		</div>
	);
}
