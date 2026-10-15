// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Dialog, Input } from "@cloudflare/kumo";
import {
	Archive,
	BarChart3,
	Bell,
	Briefcase,
	ChevronLeft,
	FolderKanban,
	FileText,
	Flame,
	Folder,
	Inbox,
	KeyRound,
	Mail,
	MoreHorizontal,
	PenSquare,
	Plus,
	RefreshCw,
	Send,
	ShieldAlert,
	Settings,
	Star,
	Target,
	Timer,
	Trash2,
	Users,
	Wallet,
	Zap,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS, ZOHO_SIDEBAR_FOLDER_IDS } from "shared/folders";
import { useMe, useSyncZoho } from "~/queries/access";
import { useMailboxStats } from "~/queries/iris";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import IrisLogo from "~/components/IrisLogo";

interface FolderLinkProps {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	onClick?: () => void;
}

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	onClick,
}: FolderLinkProps) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive }) =>
				`mx-2 flex min-h-8 items-center gap-3 rounded-r-full px-4 text-[14px] transition-colors ${
					isActive
						? "bg-[#eaf1fb] text-[#315f9f] font-medium"
						: "text-[#171717] hover:bg-[#f1f1f1]"
				}`
			}
		>
			<span className="flex w-5 items-center justify-center text-[#5f6368] shrink-0">
				{icon}
			</span>
			<span className="truncate flex-1">{label}</span>
			{unreadCount != null && unreadCount > 0 && (
				<span className="text-[12px] tabular-nums text-[#5f6368] font-medium">
					{unreadCount}
				</span>
			)}
		</NavLink>
	);
}

export default function Sidebar({ mailboxId: mailboxIdProp }: { mailboxId?: string } = {}) {
	const params = useParams<{ mailboxId: string }>();
	const mailboxId = mailboxIdProp ?? params.mailboxId;
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(mailboxId);
	const createFolderMutation = useCreateFolder();
	const syncZohoMutation = useSyncZoho();
	const { startCompose, closeSidebar } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");

	const customFolders = useMemo(
		() =>
			folders.filter((f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)),
		[folders],
	);
	const zohoFolders = useMemo(() => {
		const order = new Map(ZOHO_SIDEBAR_FOLDER_IDS.map((id, index) => [id, index]));
		return folders
			.filter((folder) => order.has(folder.id))
			.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	}, [folders]);

	const { data: stats } = useMailboxStats(mailboxId);
	const { data: me } = useMe();

	const getUnreadCount = (folderId: string) => {
		const found = folders.find((f) => f.id === folderId);
		return found?.unreadCount || 0;
	};

	const handleCreateFolder = (e: React.FormEvent) => {
		e.preventDefault();
		if (newFolderName.trim() && mailboxId) {
			createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
			setNewFolderName("");
			setIsCreateFolderOpen(false);
		}
	};

	const displayName = useMemo(() => {
		if (!currentMailbox) return mailboxId?.split("@")[0] || "Mailbox";
		if (currentMailbox.settings?.fromName) {
			return currentMailbox.settings.fromName;
		}
		if (currentMailbox.name && currentMailbox.name !== currentMailbox.email) {
			return currentMailbox.name;
		}
		return currentMailbox.email.split("@")[0] || currentMailbox.name;
	}, [currentMailbox, mailboxId]);

	const handleNavClick = () => {
		closeSidebar();
	};

	return (
		<aside className="nak-glass-sidebar sticky top-0 h-screen w-64 shrink-0 flex flex-col bg-[#f6f6f6] border-r border-[#e5e5e5] select-none">
			{/* Brand Header */}
			<div className="px-4 pb-2 pt-3">
				<Link to="/" onClick={handleNavClick} className="flex items-center gap-2 px-2 py-2">
					<img src="/favicon.png" alt="NAK Media" className="h-7 w-[60px] object-contain" />
					<span className="text-[19px] font-medium tracking-tight text-[#202124]">Mail</span>
					<span className="hidden xl:inline text-[11px] text-[#5f6368]">AI Sales Inbox</span>
				</Link>
			</div>

			{/* Compose Button */}
			<div className="mb-4 mt-2 px-3">
				<button
					type="button"
					onClick={() => {
						startCompose();
						closeSidebar();
					}}
					className="flex h-14 w-36 items-center gap-3 rounded-2xl bg-[#171717] px-5 text-[14px] font-medium text-white shadow-sm transition-shadow hover:bg-[#333333] cursor-pointer"
				>
					<PenSquare className="h-5 w-5" /> Compose
				</button>
			</div>

			{/* Active Mailbox chip */}
			{mailboxId && (
				<div className="mx-3 mb-3 px-3 py-1.5 rounded-xl bg-white border border-[#e5e5e5] shadow-xs flex items-center justify-between">
					<div className="min-w-0 flex-1">
						<div className="text-[13px] font-medium text-[#202124] truncate">
							{displayName}
						</div>
						<div className="text-[11px] text-[#5f6368] truncate">
							{currentMailbox?.email || mailboxId}
						</div>
					</div>
					{me?.role === "admin" && <button
						type="button"
						onClick={() => syncZohoMutation.mutate()}
						disabled={syncZohoMutation.isPending}
						title="Fetch new mail and folders from Zoho"
						aria-label="Sync Zoho mail"
						className="ml-1 flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-[#171717] hover:bg-[#e5e5e5] disabled:opacity-50"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${syncZohoMutation.isPending ? "animate-spin" : ""}`} />
						Sync
					</button>}
					<button
						type="button"
						onClick={() => navigate("/")}
						title="Switch mailbox"
						className="ml-2 text-[#5f6368] hover:text-[#171717] p-1 rounded-md hover:bg-[#f1f1f1] cursor-pointer"
					>
						<ChevronLeft className="h-4 w-4" />
					</button>
				</div>
			)}
			{syncZohoMutation.isSuccess && syncZohoMutation.data && <p className="mx-5 -mt-2 mb-3 text-[10px] text-[#5f6368]">Zoho sync: {syncZohoMutation.data.synced} new message{syncZohoMutation.data.synced === 1 ? "" : "s"}{syncZohoMutation.data.errors ? `, ${syncZohoMutation.data.errors} issue${syncZohoMutation.data.errors === 1 ? "" : "s"}` : ""}</p>}
			{syncZohoMutation.isError && <p className="mx-5 -mt-2 mb-3 text-[10px] text-red-700">Zoho sync failed: {(syncZohoMutation.error as Error).message}</p>}

			{/* Navigation List */}
			<div className="nak-sidebar-scrollbar flex-1 overflow-y-auto pb-6 space-y-4">
				{/* Main Email Nav */}
				<nav className="space-y-0.5">
					<FolderLink
						to={`/mailbox/${mailboxId}/emails/${Folders.INBOX}`}
						icon={<Inbox className="h-4 w-4" />}
						label="Inbox"
						unreadCount={getUnreadCount(Folders.INBOX)}
						onClick={handleNavClick}
					/>
					{zohoFolders.map((folder) => {
						const icons: Record<string, React.ReactNode> = {
							[Folders.DRAFT]: <FileText className="h-4 w-4" />,
							[Folders.TEMPLATES]: <FileText className="h-4 w-4" />,
							[Folders.SNOOZED]: <Timer className="h-4 w-4" />,
							[Folders.SENT]: <Send className="h-4 w-4" />,
							[Folders.SPAM]: <ShieldAlert className="h-4 w-4" />,
							[Folders.TRASH]: <Trash2 className="h-4 w-4" />,
							[Folders.OUTBOX]: <Send className="h-4 w-4" />,
							[Folders.NOTIFICATION]: <Bell className="h-4 w-4" />,
							[Folders.NEWSLETTER]: <Mail className="h-4 w-4" />,
							[Folders.ARCHIVE]: <Archive className="h-4 w-4" />,
						};
						return <FolderLink
							key={folder.id}
							to={folder.id === Folders.DRAFT ? `/mailbox/${mailboxId}/drafts` : `/mailbox/${mailboxId}/emails/${encodeURIComponent(folder.id)}`}
							icon={icons[folder.id] ?? <Folder className="h-4 w-4" />}
							label={folder.name}
							unreadCount={folder.unreadCount}
							onClick={handleNavClick}
						/>;
					})}
				</nav>

				<div className="pt-1">
					<p className="nak-label mb-2 px-4">Focus</p>
					<nav className="space-y-0.5">
						<FolderLink to={`/mailbox/${mailboxId}/priority`} icon={<Zap className="h-4 w-4 text-[#315f9f]" />} label="Priority" unreadCount={stats?.leads.hot} onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/emails/hot`} icon={<Flame className="h-4 w-4 text-orange-500" />} label="Hot Leads" unreadCount={stats?.leads?.hot} onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/emails/warm`} icon={<Star className="h-4 w-4 text-amber-500" />} label="Warm Leads" unreadCount={stats?.leads?.warm} onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/starred`} icon={<Star className="h-4 w-4" />} label="Starred" onClick={handleNavClick} />
					</nav>
				</div>

				{/* Custom folders */}
				<div className="pt-2">
					<div className="flex items-center justify-between px-4 mb-2">
						<p className="nak-label">Folders</p>
						<button
							type="button"
							onClick={() => setIsCreateFolderOpen(true)}
							className="text-[#5f6368] hover:text-[#171717] p-1 rounded hover:bg-[#f1f1f1] cursor-pointer"
							title="New folder"
							aria-label="New folder"
						>
							<Plus className="h-3.5 w-3.5" />
						</button>
					</div>
					<nav className="space-y-0.5">
						{customFolders.map((folder) => (
							<FolderLink
								key={folder.id}
								to={`/mailbox/${mailboxId}/emails/${folder.id}`}
								icon={<Folder className="h-4 w-4" />}
								label={folder.name}
								unreadCount={folder.unreadCount}
								onClick={handleNavClick}
							/>
						))}
						{customFolders.length === 0 && (
							<button
								type="button"
								onClick={() => setIsCreateFolderOpen(true)}
								className="mx-3 block py-1 text-xs text-[#5f6368] hover:text-[#171717] bg-transparent border-0 cursor-pointer"
							>
								+ Create a folder
							</button>
						)}
					</nav>
				</div>

				{/* Views Section */}
				<div className="pt-2">
					<p className="nak-label mb-2 px-4">Views</p>
					<nav className="space-y-0.5">
						<NavLink
							to={`/mailbox/${mailboxId}/search`}
							onClick={handleNavClick}
							className={({ isActive }) => `mx-2 flex min-h-8 items-center gap-3 rounded-r-full px-4 text-[13px] transition-colors ${isActive ? "bg-[#eaf1fb] text-[#315f9f] font-medium" : "text-[#5f6368] hover:bg-[#f1f1f1] hover:text-[#171717]"}`}
						>
							<span className="flex w-5 items-center justify-center"><Mail className="h-3.5 w-3.5" /></span>
							Search
						</NavLink>
						<NavLink
							to={`/mailbox/${mailboxId}/emails/inbox?view=unread`}
							onClick={handleNavClick}
							className="mx-2 flex min-h-8 items-center gap-3 rounded-r-full px-4 text-[13px] text-[#5f6368] hover:bg-[#f1f1f1] hover:text-[#171717] transition-colors"
						>
							<span className="flex w-5 items-center justify-center">
								<Mail className="h-3.5 w-3.5" />
							</span>
							Unread
						</NavLink>
						<NavLink
							to={`/mailbox/${mailboxId}/emails/inbox?view=all`}
							onClick={handleNavClick}
							className="mx-2 flex min-h-8 items-center gap-3 rounded-r-full px-4 text-[13px] text-[#5f6368] hover:bg-[#f1f1f1] hover:text-[#171717] transition-colors"
						>
							<span className="flex w-5 items-center justify-center">
								<MoreHorizontal className="h-3.5 w-3.5" />
							</span>
							All messages
						</NavLink>
					</nav>
				</div>

				<div className="pt-2">
					<p className="nak-label mb-2 px-4">Sales</p>
					<nav className="space-y-0.5">
						<FolderLink to={`/mailbox/${mailboxId}/leads`} icon={<Target className="h-4 w-4" />} label="Hot Leads" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/follow-ups`} icon={<Timer className="h-4 w-4" />} label="Follow-ups" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/opportunities`} icon={<Briefcase className="h-4 w-4" />} label="Opportunities" onClick={handleNavClick} />
					</nav>
				</div>

				<div className="pt-2">
					<p className="nak-label mb-2 px-4">Work</p>
					<nav className="space-y-0.5">
						<FolderLink to={`/mailbox/${mailboxId}/clients`} icon={<Users className="h-4 w-4" />} label="Clients" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/projects`} icon={<FolderKanban className="h-4 w-4" />} label="Projects" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/finance`} icon={<Wallet className="h-4 w-4" />} label="Finance" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/internal`} icon={<Mail className="h-4 w-4" />} label="Internal" onClick={handleNavClick} />
					</nav>
				</div>

				<div className="pt-2">
					<p className="nak-label mb-2 px-4">AI</p>
					<nav className="space-y-0.5">
						<FolderLink to={`/mailbox/${mailboxId}/assistant`} icon={<IrisLogo size={18} />} label="Ask Iris AI" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/automations`} icon={<Zap className="h-4 w-4 text-violet-600" />} label="Automations" onClick={handleNavClick} />
						<FolderLink to={`/mailbox/${mailboxId}/analytics`} icon={<BarChart3 className="h-4 w-4" />} label="Analytics" onClick={handleNavClick} />
					</nav>
				</div>

				<div className="pt-2">
					<p className="nak-label mb-2 px-4">Account</p>
					<nav className="space-y-0.5">
						{me?.role === "admin" && <FolderLink to={`/mailbox/${mailboxId}/api-access`} icon={<KeyRound className="h-4 w-4" />} label="API access" onClick={handleNavClick} />}
						<FolderLink
							to={`/mailbox/${mailboxId}/settings`}
							icon={<Settings className="h-4 w-4" />}
							label="Settings"
							onClick={handleNavClick}
						/>
					</nav>
				</div>
			</div>

			{/* Footer */}
			<div className="border-t border-[#e5e5e5] px-5 py-3">
				<p className="text-[11px] text-[#5f6368]">Your inbox. With intelligence.</p>
			</div>

			{/* Create Folder Dialog */}
			<Dialog.Root open={isCreateFolderOpen} onOpenChange={setIsCreateFolderOpen}>
				<Dialog size="sm" className="p-6 bg-white rounded-2xl shadow-xl border border-[#e5e5e5]">
					<Dialog.Title className="text-base font-semibold text-[#171717] mb-4">
						Create folder
					</Dialog.Title>
					<form onSubmit={handleCreateFolder} className="space-y-4">
						<Input
							label="Folder name"
							placeholder="e.g. Clients"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
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
								disabled={!newFolderName.trim()}
								className="nak-btn !py-1.5 !px-4 text-xs disabled:opacity-50"
							>
								Create
							</button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}
