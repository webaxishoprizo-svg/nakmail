// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Bell, Menu, Search, Settings, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailbox } from "~/queries/mailboxes";
import { useMe } from "~/queries/access";
import { useFolders } from "~/queries/folders";
import IrisLogo from "~/components/IrisLogo";

export default function Header() {
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAgentPanel } = useUIStore();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: me } = useMe();

	// Sync search input with URL query param so it stays populated
	const urlQuery = searchParams.get("q") || "";
	useEffect(() => {
		if (location.pathname.includes("/search") && urlQuery) {
			setSearchQuery(urlQuery);
		}
	}, [urlQuery, location.pathname]);

	const performSearch = () => {
		if (mailboxId && searchQuery.trim()) {
			const q = searchQuery.trim();
			navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(q)}`);
			setIsSearchExpanded(false);
		}
	};

	const clearSearch = () => {
		setSearchQuery("");
		if (location.pathname.includes("/search") && mailboxId) {
			navigate(`/mailbox/${mailboxId}/emails/inbox`);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			performSearch();
		}
		if (e.key === "Escape") {
			if (searchQuery) {
				clearSearch();
			} else {
				setIsSearchExpanded(false);
			}
		}
	};

	// Determine header title from path
	let title = "Home";
	if (location.pathname.includes("/emails/inbox")) title = "Inbox";
	else if (location.pathname.includes("/priority")) title = "Priority";
	else if (location.pathname.includes("/starred")) title = "Starred";
	else if (location.pathname.includes("/emails/hot")) title = "Hot Leads";
	else if (location.pathname.includes("/emails/warm")) title = "Warm Leads";
	else if (location.pathname.includes("/emails/draft")) title = "Drafts";
	else if (location.pathname.includes("/drafts")) title = "Drafts";
	else if (location.pathname.includes("/emails/sent")) title = "Sent";
	else if (location.pathname.includes("/leads")) title = "Hot Leads";
	else if (location.pathname.includes("/follow-ups")) title = "Follow-ups";
	else if (location.pathname.includes("/opportunities")) title = "Opportunities";
	else if (location.pathname.includes("/clients")) title = "Clients";
	else if (location.pathname.includes("/projects")) title = "Projects";
	else if (location.pathname.includes("/finance")) title = "Finance";
	else if (location.pathname.includes("/internal")) title = "Internal";
	else if (location.pathname.includes("/analytics")) title = "Analytics";
	else if (location.pathname.includes("/assistant")) title = "AI Assistant";
	else if (location.pathname.includes("/api-access")) title = "API access";
	else if (location.pathname.includes("/settings")) title = "Settings";
	else if (location.pathname.includes("/automation")) title = "Automations";
	else if (location.pathname.includes("/search")) title = "Search";
	else {
		const folderSegment = location.pathname.match(/\/emails\/([^/]+)/)?.[1];
		if (folderSegment) {
			let folderId = folderSegment;
			try { folderId = decodeURIComponent(folderSegment); } catch { /* keep the path segment */ }
			title = folders.find((folder) => folder.id === folderId)?.name ?? folderId.charAt(0).toUpperCase() + folderId.slice(1);
		}
	}

	const profileLetter =
		me?.email?.charAt(0).toUpperCase() ||
		mailbox?.email?.charAt(0).toUpperCase() ||
		"N";

	return (
		<header className="nak-glass-header sticky top-0 z-10 border-b border-[#e5e5e5] bg-[#f6f6f6]">
			<div className="flex h-16 items-center gap-3 px-3 sm:px-6">
				{/* Mobile menu button */}
				<button
					type="button"
					onClick={toggleSidebar}
					aria-label="Open navigation"
					className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#686868] hover:bg-[#f1f1f1] md:hidden cursor-pointer bg-transparent border-0"
				>
					<Menu className="h-5 w-5" />
				</button>

				{/* Mobile Brand */}
				<div className="md:hidden flex items-center">
					<Link to="/" className="flex items-center gap-2 px-1 py-1">
						<img src="/favicon.png" alt="NAK Media" className="h-6 w-auto object-contain" />
						<span className="text-[17px] font-medium tracking-tight text-[#202124]">Mail</span>
					</Link>
				</div>

				{/* Section title */}
				<h1 className="hidden max-w-36 shrink-0 truncate text-sm font-medium text-[#3c4043] md:block">
					{title}
				</h1>

				{/* Google / NAK Search Pill */}
				<form
					role="search"
					onSubmit={(e) => {
						e.preventDefault();
						performSearch();
					}}
					className="relative flex h-12 min-w-0 flex-1 items-center gap-3 rounded-full bg-[#f1f1f1] px-4 text-[16px] text-[#686868] transition-all focus-within:bg-white focus-within:shadow-[0_1px_6px_rgba(32,33,36,.18)] md:max-w-[56rem] md:px-6"
				>
					<button type="submit" aria-label="Search mail" className="shrink-0 bg-transparent border-0 cursor-pointer p-0 text-[#686868]">
						<Search className="h-5 w-5" />
					</button>
					<input
						type="search"
						name="q"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Search mail (try from:name, is:unread, has:attachment)"
						aria-label="Search mail"
						autoComplete="off"
						className="min-w-0 flex-1 bg-transparent text-[15px] text-[#202124] outline-none placeholder:text-[#5f6368]"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={clearSearch}
							className="p-1 rounded-full text-[#5f6368] hover:text-[#171717] hover:bg-[#e8eaed] cursor-pointer bg-transparent border-0"
							aria-label="Clear search"
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</form>

				{/* Ask Iris AI button */}
				<button
					type="button"
					onClick={toggleAgentPanel}
					aria-label="Ask Iris AI"
					title="Ask Iris AI"
					className="hidden h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#171717] px-4 text-sm font-medium text-white transition-colors hover:bg-[#333333] md:flex cursor-pointer border-0"
				>
					<IrisLogo size={18} />
					<span>Ask Iris AI</span>
				</button>

				{/* Action icons right */}
				<div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
					<button
						type="button"
						aria-label="Notifications"
						title="Notifications"
						className="hidden h-10 w-10 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#e8eaed] sm:flex bg-transparent border-0 cursor-pointer"
					>
						<Bell className="h-5 w-5" />
					</button>

					<button
						type="button"
						aria-label="Settings"
						title="Settings"
						onClick={() =>
							navigate(
								location.pathname.includes("/settings")
									? `/mailbox/${mailboxId}/emails/inbox`
									: `/mailbox/${mailboxId}/settings`,
							)
						}
						className="hidden h-10 w-10 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#e8eaed] md:flex bg-transparent border-0 cursor-pointer"
					>
						<Settings className="h-5 w-5" />
					</button>

					{/* Profile Avatar */}
					<Link
						to={`/mailbox/${mailboxId}/settings`}
						aria-label="Profile"
						title="Profile"
						className="ml-1 flex h-9 w-9 items-center justify-center rounded-full bg-[#171717] text-[13px] font-medium text-white ring-2 ring-white shadow-sm no-underline"
					>
						{profileLetter}
					</Link>
				</div>
			</div>
		</header>
	);
}
