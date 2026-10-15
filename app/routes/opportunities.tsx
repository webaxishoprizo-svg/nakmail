import { useParams } from "react-router";
import { Briefcase } from "lucide-react";
import { useEmails } from "~/queries/emails";
import { useUIStore } from "~/hooks/useUIStore";

export default function OpportunitiesRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: emailData } = useEmails(mailboxId, { limit: "50" });
	const { startCompose } = useUIStore();

	const emails = emailData?.emails ?? [];
	// Emails with commercial / pricing intent
	const opportunityEmails = emails.filter(
		(e) =>
			e.subject?.toLowerCase().includes("quote") ||
			e.subject?.toLowerCase().includes("proposal") ||
			e.subject?.toLowerCase().includes("pricing") ||
			e.subject?.toLowerCase().includes("contract") ||
			e.level === "hot",
	);

	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-3xl mx-auto">
				{/* Header */}
				<div className="pb-6 border-b border-[#e5e5e5]">
					<div className="flex items-center gap-2">
						<Briefcase className="h-5 w-5 text-[#315f9f]" />
						<p className="nak-label">Pipeline Intelligence</p>
					</div>
					<h2 className="nak-display text-4xl mt-2 text-[#171717]">Opportunities</h2>
					<p className="text-sm text-[#5f6368] mt-1.5 leading-relaxed">
						Leads become opportunities only when a budget, contract, or value is explicitly discussed — never estimated or fabricated.
					</p>
				</div>

				{/* Cards */}
				<div className="mt-8 space-y-3">
					{opportunityEmails.length === 0 ? (
						<div className="nak-card p-12 text-center">
							<Briefcase className="h-10 w-10 text-[#5f6368] mx-auto mb-3 opacity-40" />
							<p className="text-sm font-semibold text-[#171717]">No valued opportunities yet</p>
							<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto">
								When a contact mentions a budget, proposal, or commercial scope in their emails, it will be organized here.
							</p>
						</div>
					) : (
						opportunityEmails.map((item) => (
							<div
								key={item.id}
								className="nak-card p-5 flex items-center gap-4 hover:bg-[#eaf1fb]/30 transition-colors"
							>
								<span className="h-2.5 w-2.5 rounded-full bg-[#f20d18] shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-[#171717] truncate">{item.sender}</p>
									<p className="text-xs text-[#5f6368] mt-0.5 truncate">{item.subject}</p>
								</div>
								<button
									type="button"
									onClick={() => startCompose({ to: item.sender, subject: `Proposal: ${item.subject}` })}
									className="nak-btn !py-1.5 !px-3 text-xs shrink-0"
								>
									Open Deal
								</button>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
