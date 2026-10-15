import { useState } from "react";
import { useParams } from "react-router";
import { Flame, Target } from "lucide-react";
import { useEmails } from "~/queries/emails";
import { useMailboxStats } from "~/queries/iris";
import { useUIStore } from "~/hooks/useUIStore";

type LeadStatus = "new" | "qualified" | "contacted" | "proposal" | "negotiation" | "won";

const STATUS_LABELS: Record<LeadStatus, string> = {
	new: "New Lead",
	qualified: "Qualified",
	contacted: "Contacted",
	proposal: "Proposal",
	negotiation: "Negotiation",
	won: "Won",
};

const PIPELINE_COLUMNS: LeadStatus[] = [
	"new",
	"qualified",
	"contacted",
	"proposal",
	"negotiation",
	"won",
];

export default function LeadsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [view, setView] = useState<"list" | "pipeline">("list");
	const { data: stats } = useMailboxStats(mailboxId);
	const { data: emailData } = useEmails(mailboxId, { limit: "100" });
	const { startCompose } = useUIStore();

	const emails = emailData?.emails ?? [];

	// Map emails that have hot/warm levels or priority signals into leads
	const hotEmails = emails.filter((e) => e.level === "hot" || (e.score && e.score >= 50));
	const warmEmails = emails.filter((e) => e.level === "warm" || (e.score && e.score >= 30 && e.score < 50));
	const allLeads = emails.length > 0
		? emails.filter((e) => e.level || (e.score && e.score > 20))
		: [];

	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-5xl mx-auto">
				{/* Header */}
				<div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 border-b border-[#e5e5e5]">
					<div>
						<div className="flex items-center gap-2">
							<Target className="h-5 w-5 text-[#f20d18]" />
							<p className="nak-label">Sales Intelligence</p>
						</div>
						<h2 className="nak-display text-4xl mt-2 text-[#171717]">Hot Leads</h2>
						<p className="text-sm text-[#5f6368] mt-1.5 max-w-xl">
							Detected from your Zoho inbox. Leads with strong signals, budget discussions, or active client requests.
						</p>
					</div>

					<div className="flex items-center border border-[#e5e5e5] rounded-lg overflow-hidden shrink-0 self-start sm:self-auto">
						<button
							type="button"
							onClick={() => setView("list")}
							className={`text-xs px-3.5 py-1.5 font-medium transition-colors cursor-pointer ${
								view === "list"
									? "bg-[#171717] text-white"
									: "bg-white text-[#171717] hover:bg-[#f6f6f6]"
							}`}
						>
							List view
						</button>
						<button
							type="button"
							onClick={() => setView("pipeline")}
							className={`text-xs px-3.5 py-1.5 font-medium transition-colors cursor-pointer border-l border-[#e5e5e5] ${
								view === "pipeline"
									? "bg-[#171717] text-white"
									: "bg-white text-[#171717] hover:bg-[#f6f6f6]"
							}`}
						>
							Pipeline view
						</button>
					</div>
				</div>

				{/* Summary Metrics */}
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-6">
					<div className="nak-card p-4">
						<p className="nak-label">Hot Leads</p>
						<p className="nak-display text-2xl mt-1 text-[#f20d18]">{stats?.leads.hot ?? hotEmails.length}</p>
					</div>
					<div className="nak-card p-4">
						<p className="nak-label">Warm Leads</p>
						<p className="nak-display text-2xl mt-1 text-[#e37400]">{stats?.leads.warm ?? warmEmails.length}</p>
					</div>
					<div className="nak-card p-4">
						<p className="nak-label">Identified Contacts</p>
						<p className="nak-display text-2xl mt-1 text-[#171717]">{allLeads.length}</p>
					</div>
					<div className="nak-card p-4">
						<p className="nak-label">Pipeline Value</p>
						<p className="nak-display text-2xl mt-1 text-[#171717]">—</p>
						<p className="text-[11px] text-[#5f6368] mt-0.5">Stated in emails</p>
					</div>
				</div>

				{/* Content */}
				{view === "list" ? (
					<div className="mt-8 border border-[#e5e5e5] rounded-xl overflow-hidden shadow-xs">
						<div className="grid grid-cols-12 gap-4 px-5 py-3 bg-[#f6f6f6] border-b border-[#e5e5e5]">
							<p className="nak-label col-span-4">Contact / Company</p>
							<p className="nak-label col-span-3">Signals & Intent</p>
							<p className="nak-label col-span-2">Score</p>
							<p className="nak-label col-span-3 text-right">Actions</p>
						</div>

						{allLeads.length === 0 ? (
							<div className="py-16 text-center px-4">
								<Flame className="h-10 w-10 text-[#5f6368] mx-auto mb-3 opacity-40" />
								<p className="text-sm font-semibold text-[#171717]">No active leads yet</p>
								<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto">
									As incoming client inquiries arrive in Zoho Mail, AI automatically extracts and scores leads here.
								</p>
							</div>
						) : (
							<div className="divide-y divide-[#e5e5e5]">
								{allLeads.map((item) => (
									<div
										key={item.id}
										className="grid grid-cols-12 gap-4 px-5 py-4 items-center hover:bg-[#f6f6f6] transition-colors"
									>
										<div className="col-span-4 min-w-0">
											<div className="flex items-center gap-2">
												<span
													className={`h-2.5 w-2.5 rounded-full shrink-0 ${
														item.level === "hot" ? "bg-[#f20d18]" : "bg-[#e37400]"
													}`}
												/>
												<span className="text-sm font-medium text-[#171717] truncate">
													{item.sender}
												</span>
											</div>
											<p className="text-xs text-[#5f6368] truncate mt-0.5 ml-4.5">
												{item.subject}
											</p>
										</div>

										<div className="col-span-3 min-w-0">
											<span className="inline-block text-xs text-[#315f9f] bg-[#eaf1fb] px-2.5 py-0.5 rounded-full font-medium truncate max-w-full">
												{(item.signals ?? []).slice(0, 1)[0] || "Inquiry"}
											</span>
										</div>

										<div className="col-span-2">
											<span
												className={`text-xs font-semibold px-2 py-0.5 rounded ${
													item.level === "hot"
														? "bg-red-100 text-red-700"
														: "bg-amber-100 text-amber-700"
												}`}
											>
												{item.level === "hot" ? "HOT" : "WARM"} {item.score ?? 50}
											</span>
										</div>

										<div className="col-span-3 flex justify-end gap-2">
											<button
												type="button"
												onClick={() => startCompose({ to: item.sender, subject: `Re: ${item.subject}` })}
												className="nak-btn !py-1 !px-3 text-xs"
											>
												Reply
											</button>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				) : (
					<div className="mt-8 flex gap-4 overflow-x-auto pb-4">
						{PIPELINE_COLUMNS.map((col) => (
							<div key={col} className="w-60 shrink-0 bg-[#f6f6f6] p-3 rounded-xl border border-[#e5e5e5]">
								<div className="flex items-center justify-between mb-3 px-1">
									<p className="nak-label">{STATUS_LABELS[col]}</p>
									<span className="text-[11px] font-medium text-[#5f6368]">
										{col === "new" ? hotEmails.length : 0}
									</span>
								</div>

								<div className="space-y-2">
									{col === "new" &&
										hotEmails.slice(0, 5).map((e) => (
											<div
												key={e.id}
												className="nak-card p-3 shadow-xs hover:border-[#315f9f] transition-colors cursor-pointer"
												onClick={() => startCompose({ to: e.sender, subject: `Re: ${e.subject}` })}
											>
												<div className="flex items-center gap-1.5">
													<span className="h-2 w-2 rounded-full bg-[#f20d18]" />
													<p className="text-xs font-medium text-[#171717] truncate">
														{e.sender.split("@")[0]}
													</p>
												</div>
												<p className="text-[11px] text-[#5f6368] mt-1 line-clamp-2">
													{e.subject}
												</p>
											</div>
										))}

									{col !== "new" && (
										<div className="py-6 text-center text-xs text-[#5f6368] border border-dashed border-[#dadce0] rounded-lg">
											Empty
										</div>
									)}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
