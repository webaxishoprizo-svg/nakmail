import { useParams } from "react-router";
import { AlertCircle, Clock, Send, Timer } from "lucide-react";
import { useEmails } from "~/queries/emails";
import { useUIStore } from "~/hooks/useUIStore";

export default function FollowUpsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: emailData } = useEmails(mailboxId, { limit: "50" });
	const { startCompose } = useUIStore();

	const emails = emailData?.emails ?? [];
	// Emails that require reply or are unreplied conversations
	const pendingFollowUps = emails.filter((e) => e.needs_reply || (e.thread_count && e.thread_count > 1));

	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-3xl mx-auto">
				{/* Header */}
				<div className="pb-6 border-b border-[#e5e5e5]">
					<div className="flex items-center gap-2">
						<Timer className="h-5 w-5 text-[#315f9f]" />
						<p className="nak-label">Automation & Sequences</p>
					</div>
					<h2 className="nak-display text-4xl mt-2 text-[#171717]">Follow-ups Due</h2>
					<p className="text-sm text-[#5f6368] mt-1.5 leading-relaxed">
						Stale conversations detected automatically. AI drafts suggested responses — you review and approve before anything is sent.
					</p>
				</div>

				{/* Cards list */}
				<div className="mt-8 space-y-4">
					{pendingFollowUps.length === 0 ? (
						<div className="nak-card p-12 text-center">
							<Clock className="h-10 w-10 text-[#5f6368] mx-auto mb-3 opacity-40" />
							<p className="text-sm font-semibold text-[#171717]">No follow-ups due right now</p>
							<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto">
								When contacts haven't replied to a sent message or a thread goes quiet, AI surfaces it here.
							</p>
						</div>
					) : (
						pendingFollowUps.map((item, idx) => (
							<div key={item.id} className="nak-card p-5 hover:border-[#315f9f]/40 transition-colors">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm font-semibold text-[#171717] truncate">{item.sender}</p>
										<p className="text-xs text-[#5f6368] mt-0.5 truncate">{item.subject}</p>
									</div>
									<div className="text-right shrink-0">
										<p className="text-xs font-semibold tabular-nums text-[#e37400]">
											{idx + 2} days
										</p>
										<p className="text-[11px] text-[#5f6368]">since contact</p>
									</div>
								</div>

								{idx === 0 && (
									<div className="flex items-center gap-1.5 mt-3 text-xs text-[#f20d18] font-medium bg-red-50 px-2.5 py-1 rounded-md w-fit">
										<AlertCircle className="h-3.5 w-3.5" /> At risk of going cold
									</div>
								)}

								<p className="text-xs text-[#202124] leading-relaxed mt-3 pt-3 border-t border-[#e5e5e5]">
									Suggested: Follow up regarding project scope and schedule a 15-min discovery call.
								</p>

								<div className="flex items-center gap-2 mt-4 pt-1">
									<button
										type="button"
										onClick={() =>
											startCompose({
												to: item.sender,
												subject: `Follow-up: ${item.subject}`,
											})
										}
										className="nak-btn !py-1.5 !px-3 text-xs"
									>
										<Send className="h-3 w-3" /> Draft follow-up
									</button>
									<button type="button" className="nak-btn-ghost !py-1.5 !px-3 text-xs">
										Snooze 3 days
									</button>
									<span className="nak-label ml-auto">Awaiting response</span>
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
