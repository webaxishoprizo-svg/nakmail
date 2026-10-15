// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Dialog, Input, Loader, Select } from "@cloudflare/kumo";
import {
	ArrowRight,
	Briefcase,
	ChevronRight,
	Menu,
	Inbox,
	Mail,
	PenSquare,
	Plus,
	Search,
	Timer,
	Trash2,
	Zap,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import { useMailboxStats } from "~/queries/iris";
import { useEmails } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import Sidebar from "~/components/Sidebar";
import { useUIStore } from "~/hooks/useUIStore";
import { formatListDate } from "shared/dates";
import { getSnippetText } from "~/lib/utils";
import IrisLogo from "~/components/IrisLogo";

export function meta() {
	return [
		{ title: "NAK Mail — AI-powered sales inbox" },
		{
			name: "description",
			content:
				"NAK Mail: your inbox, with intelligence. AI-powered sales inbox for NAK Media on top of Zoho Mail.",
		},
	];
}

function greeting() {
	const h = new Date().getHours();
	if (h < 12) return "Good morning";
	if (h < 17) return "Good afternoon";
	return "Good evening";
}

function Metric({
	label,
	value,
	hint,
}: {
	label: string;
	value: string | number;
	hint?: string;
}) {
	return (
		<div className="nak-card px-5 py-4">
			<p className="nak-label">{label}</p>
			<p className="nak-display text-3xl mt-2 tabular-nums text-[#171717]">{value}</p>
			{hint && <p className="text-xs text-[#5f6368] mt-1">{hint}</p>}
		</div>
	);
}

export default function HomeRoute() {
	const navigate = useNavigate();
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => {
			if (!cancelled) refetchMailboxes();
		});
		return () => {
			cancelled = true;
		};
	}, [emailAddresses, mailboxes, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			// error handled
		} finally {
			setIsDeleting(false);
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const accounts = isConfigured
		? emailAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
			}))
		: mailboxes;

	const isLoading = !configData;
	const firstMailboxId = accounts[0]?.id;
	const { data: mailboxStats } = useMailboxStats(firstMailboxId);
	const { data: inboxData } = useEmails(
		firstMailboxId,
		{ folder: "inbox", page: "1", limit: "100" },
		{ enabled: !!firstMailboxId },
	);
	const { data: hotData } = useEmails(
		firstMailboxId,
		{ folder: "hot", page: "1", limit: "100" },
		{ enabled: !!firstMailboxId },
	);
	const { data: folders = [] } = useFolders(firstMailboxId);
	const { isSidebarOpen, toggleSidebar, closeSidebar } = useUIStore();
	const inboxEmails = inboxData?.emails ?? [];
	const unreadCount = folders.find((folder) => folder.id === "inbox")?.unreadCount
		?? inboxEmails.filter((email) => !email.read).length;
	const needsReplyCount = inboxEmails.filter((email) => email.needs_reply).length;
	const potentialLeads = (mailboxStats?.leads.hot ?? 0) + (mailboxStats?.leads.warm ?? 0);
	const inboxNeedsReply = inboxEmails.filter((email) => email.needs_reply);
	const needsReplyIds = new Set(inboxNeedsReply.map((email) => email.id));
	const priorities = [...inboxNeedsReply, ...(hotData?.emails ?? []).filter((email) => !needsReplyIds.has(email.id))]
		.sort((a, b) => Number(b.needs_reply) - Number(a.needs_reply) || (b.score ?? 0) - (a.score ?? 0))
		.slice(0, 5);

	const formattedDate = new Date().toLocaleDateString("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
	});

	return (
		<div className="nak-app-shell flex min-h-screen font-sans">
			{firstMailboxId && (
				<>
					<div className="hidden md:block"><Sidebar mailboxId={firstMailboxId} /></div>
					{isSidebarOpen && (
						<button type="button" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={closeSidebar} aria-label="Close navigation" />
					)}
					<div className={`fixed inset-y-0 left-0 z-40 w-64 transition-transform duration-200 md:hidden ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
						<Sidebar mailboxId={firstMailboxId} />
					</div>
				</>
			)}
			<div className="flex min-w-0 flex-1 flex-col">
			{/* Top Bar Header */}
			<header className="nak-glass-header sticky top-0 z-10 border-b border-[#e5e5e5] bg-[#f6f6f6]">
				<div className="flex h-16 items-center gap-3 px-4 sm:px-6">
					{firstMailboxId && (
						<button type="button" onClick={toggleSidebar} aria-label="Open navigation" className="flex h-10 w-10 items-center justify-center rounded-full text-[#686868] hover:bg-[#f1f1f1] md:hidden">
							<Menu className="h-5 w-5" />
						</button>
					)}
					<h1 className="hidden shrink-0 text-sm font-medium text-[#3c4043] md:block">Home</h1>
					<Link to="/" className="flex items-center gap-2 md:hidden">
						<img src="/favicon.png" alt="NAK Media" className="h-6 w-auto object-contain" />
						<span className="text-[17px] font-medium tracking-tight text-[#202124]">Mail</span>
					</Link>

					{/* Search Bar */}
					<form
						role="search"
						onSubmit={(e) => {
							e.preventDefault();
							if (firstMailboxId && searchQuery.trim()) {
								navigate(`/mailbox/${firstMailboxId}/search?q=${encodeURIComponent(searchQuery.trim())}`);
							}
						}}
						className="relative flex h-12 min-w-0 flex-1 items-center gap-3 rounded-full bg-[#f1f1f1] px-4 text-[16px] text-[#686868] transition-all focus-within:bg-white focus-within:shadow-[0_1px_6px_rgba(32,33,36,.18)] md:max-w-[42rem] md:px-6 mx-auto"
					>
						<Search className="h-5 w-5 shrink-0 text-[#686868]" />
						<input
							type="search"
							placeholder="Search mail..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="min-w-0 flex-1 bg-transparent text-[15px] text-[#202124] outline-none placeholder:text-[#5f6368]"
						/>
					</form>

					{/* Action Buttons */}
					<div className="flex items-center gap-2">
						{firstMailboxId && (
							<Link
							to={`/mailbox/${firstMailboxId}/assistant`}
								className="hidden sm:flex h-10 items-center justify-center gap-2 rounded-full bg-[#171717] px-4 text-sm font-medium text-white hover:bg-[#333333] no-underline transition-colors"
							>
								<IrisLogo size={18} />
								<span>Ask Iris AI</span>
							</Link>
						)}
						<div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#171717] text-[13px] font-medium text-white ring-2 ring-white shadow-sm">
							N
						</div>
					</div>
				</div>
			</header>

			{/* Main Content Dashboard Area */}
			<main className="flex-1 max-w-5xl w-full mx-auto px-6 py-10 md:px-8">
				{/* Greeting Header */}
				<div>
					<p className="nak-label">{formattedDate}</p>
					<h2 className="nak-display text-5xl mt-3 text-[#202124]">{greeting()}.</h2>
					<p className="text-sm text-[#5f6368] mt-3 max-w-xl leading-relaxed">
						{accounts.length} connected mailbox{accounts.length !== 1 ? "es" : ""} ready — your AI sales workspace on top of Zoho Mail.
					</p>
				</div>

				{/* 4 Metric Cards */}
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-10">
					<Metric label="Inbox" value={inboxData?.totalCount ?? "—"} hint={`${unreadCount} unread`} />
					<Metric label="Needs attention" value={needsReplyCount} hint="Conversations awaiting a reply" />
					<Metric label="Potential leads" value={potentialLeads} hint={`${mailboxStats?.leads.hot ?? 0} hot · ${mailboxStats?.leads.warm ?? 0} warm`} />
					<Metric label="Sent today" value={mailboxStats?.today.sent ?? "—"} hint="Synced from Zoho Mail" />
				</div>

				<div className="mt-10">
					<div className="mb-4 flex items-center justify-between gap-3">
						<div>
							<p className="nak-label">Your next actions</p>
							<h3 className="nak-display mt-1 text-2xl text-[#202124]">Today’s priorities</h3>
						</div>
						{firstMailboxId && <Link to={`/mailbox/${firstMailboxId}/priority`} className="text-xs font-medium text-[#315f9f] no-underline hover:underline">View all <ArrowRight className="ml-1 inline h-3.5 w-3.5" /></Link>}
					</div>
					{priorities.length ? (
						<div className="nak-card divide-y divide-[#e5e5e5] overflow-hidden">
							{priorities.map((email) => (
								<Link key={email.id} to={`/mailbox/${firstMailboxId}/emails/inbox?open=${encodeURIComponent(email.id)}`} className="group flex items-center gap-3 px-4 py-3 no-underline hover:bg-[#f6f6f6] sm:px-5">
									<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${email.needs_reply ? "bg-[#d97706]" : "bg-[#dc2626]"}`} />
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-2"><span className="truncate text-sm font-medium text-[#202124]">{email.sender}</span><span className="shrink-0 text-[11px] text-[#5f6368]">{email.needs_reply ? "Needs reply" : `Hot lead · ${email.score ?? 0}`}</span></span>
										<span className="mt-0.5 block truncate text-xs text-[#5f6368]">{email.subject}{email.snippet ? ` — ${getSnippetText(email.snippet, 100)}` : ""}</span>
									</span>
									<span className="hidden shrink-0 text-xs text-[#5f6368] sm:block">{formatListDate(email.date)}</span>
								</Link>
							))}
						</div>
					) : (
						<div className="nak-card px-5 py-8 text-center text-sm text-[#5f6368]">You’re all caught up. New lead signals and conversations needing a reply will appear here.</div>
					)}
				</div>

								{/* Connected Mailboxes Section */}
				<div className="mt-12">
					<div className="flex items-center justify-between mb-4">
						<h3 className="nak-display text-2xl text-[#202124]">Connected Mailboxes</h3>
						{!isConfigured && (
							<button
								type="button"
								onClick={() => setIsCreateOpen(true)}
								className="nak-btn !py-2 !px-4 text-xs flex items-center gap-1.5"
							>
								<Plus className="h-4 w-4" /> New Mailbox
							</button>
						)}
					</div>

					{isLoading ? (
						<div className="flex justify-center py-16">
							<Loader size="lg" />
						</div>
					) : accounts.length > 0 ? (
						<div className="nak-card divide-y divide-[#e5e5e5] overflow-hidden">
							{accounts.map((account) => (
								<Link
									key={account.id}
									to={`/mailbox/${account.id}/emails/inbox`}
									className="group flex items-center gap-4 px-6 py-4.5 no-underline transition-colors hover:bg-[#f6f6f6]"
								>
									<div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#171717] text-sm font-semibold text-white shadow-xs">
										{account.name.charAt(0).toUpperCase()}
									</div>
									<div className="min-w-0 flex-1">
										<div className="text-[15px] font-semibold text-[#202124] group-hover:text-[#315f9f] transition-colors truncate">
											{account.name}
										</div>
										<div className="text-xs text-[#5f6368] mt-0.5 truncate">
											{account.email}
										</div>
									</div>
									<div className="flex items-center gap-3">
										<span className="hidden sm:inline-flex items-center text-xs font-medium text-[#315f9f] bg-[#eaf1fb] px-3 py-1 rounded-full">
											Open Mailbox
										</span>
										<ChevronRight className="h-5 w-5 text-[#c4c7c5] group-hover:text-[#171717] transition-colors" />
									</div>
								</Link>
							))}
						</div>
					) : (
						<div className="nak-card py-16 px-6 text-center">
							<Mail className="h-12 w-12 text-[#5f6368] mx-auto mb-3 opacity-60" />
							<p className="text-base font-semibold text-[#202124]">No mailboxes configured</p>
							<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto mb-4">
								Add your email address to start managing your inbox with AI intelligence.
							</p>
							{!isConfigured && (
								<button
									type="button"
									onClick={() => setIsCreateOpen(true)}
									className="nak-btn !py-2 !px-4 text-xs mx-auto"
								>
									<Plus className="h-4 w-4" /> Create Mailbox
								</button>
							)}
						</div>
					)}
				</div>

				{/* Today's Priorities / Quick Access Cards */}
				<div className="grid md:grid-cols-2 gap-4 mt-10">
					{firstMailboxId ? (
						<Link
							to={`/mailbox/${firstMailboxId}/drafts`}
							className="nak-card p-5 hover:bg-[#eaf1fb]/40 transition-colors group no-underline"
						>
							<div className="flex items-center gap-2">
								<Timer className="h-4 w-4 text-[#5f6368]" />
								<p className="nak-label">Follow-ups due</p>
							</div>
							<p className="nak-display text-2xl mt-3 text-[#171717]">Drafts & Reminders</p>
							<p className="text-xs text-[#5f6368] mt-1">
								Review outgoing drafts and automated follow-up sequences.
							</p>
						</Link>
					) : (
						<div className="nak-card p-5">
							<div className="flex items-center gap-2">
								<Timer className="h-4 w-4 text-[#5f6368]" />
								<p className="nak-label">Follow-ups due</p>
							</div>
							<p className="nak-display text-2xl mt-3 text-[#171717]">0 drafts</p>
						</div>
					)}

					{firstMailboxId ? (
						<Link
							to={`/mailbox/${firstMailboxId}/emails/hot`}
							className="nak-card p-5 hover:bg-[#eaf1fb]/40 transition-colors group no-underline"
						>
							<div className="flex items-center gap-2">
								<Briefcase className="h-4 w-4 text-[#5f6368]" />
								<p className="nak-label">Hot leads</p>
							</div>
							<p className="nak-display text-2xl mt-3 text-[#171717]">AI Priority Inbox</p>
							<p className="text-xs text-[#5f6368] mt-1">
								High-intent clients classified by Workers AI & Zoho Mail.
							</p>
						</Link>
					) : (
						<div className="nak-card p-5">
							<div className="flex items-center gap-2">
								<Briefcase className="h-4 w-4 text-[#5f6368]" />
								<p className="nak-label">Hot leads</p>
							</div>
							<p className="nak-display text-2xl mt-3 text-[#171717]">0 leads</p>
						</div>
					)}
				</div>
			</main>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6 bg-white rounded-2xl shadow-xl border border-[#e5e5e5]">
					<Dialog.Title className="text-base font-semibold text-[#171717] mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<p className="text-xs text-red-600">{createError}</p>
						)}
						<div>
							<span className="text-sm font-medium text-[#202124] mb-1.5 block">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-[#5f6368]">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
										<Select
											aria-label="Domain"
											value={selectedDomain}
											onValueChange={(value) => {
												if (value) setSelectedDomain(value);
											}}
										>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-[#5f6368]">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<button
										{...props}
										type="button"
										className="nak-btn-ghost !py-1.5 !px-3 text-xs"
									>
										Cancel
									</button>
								)}
							/>
							<button
								type="submit"
								disabled={!selectedDomain || isCreating}
								className="nak-btn !py-1.5 !px-4 text-xs disabled:opacity-50"
							>
								{isCreating ? "Creating..." : "Create"}
							</button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6 bg-white rounded-2xl shadow-xl border border-[#e5e5e5]">
					<Dialog.Title className="text-base font-semibold text-[#171717] mb-2">
						Delete Mailbox
					</Dialog.Title>
					<p className="text-xs text-[#5f6368] mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-[#171717]">{mailboxToDelete?.email}</strong>?
						This action cannot be undone.
					</p>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<button
									{...props}
									type="button"
									className="nak-btn-ghost !py-1.5 !px-3 text-xs"
								>
									Cancel
								</button>
							)}
						/>
						<button
							type="button"
							onClick={handleDelete}
							disabled={isDeleting}
							className="nak-btn !bg-red-600 hover:!bg-red-700 !py-1.5 !px-4 text-xs disabled:opacity-50"
						>
							{isDeleting ? "Deleting..." : "Delete"}
						</button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
		</div>
	);
}
