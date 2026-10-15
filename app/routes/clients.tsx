import { useParams } from "react-router";
import { Users } from "lucide-react";
import { useEmails } from "~/queries/emails";
import { useUIStore } from "~/hooks/useUIStore";

export default function ClientsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: emailData } = useEmails(mailboxId, { limit: "50" });
	const { selectEmail } = useUIStore();

	const emails = emailData?.emails ?? [];
	const clientEmails = emails.filter((e) => !e.sender.includes("noreply") && !e.sender.includes("notification"));

	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-3xl mx-auto">
				<div className="pb-6 border-b border-[#e5e5e5]">
					<div className="flex items-center gap-2">
						<Users className="h-5 w-5 text-[#315f9f]" />
						<p className="nak-label">Work & Client Relations</p>
					</div>
					<h2 className="nak-display text-4xl mt-2 text-[#171717]">Clients</h2>
					<p className="text-sm text-[#5f6368] mt-1.5">
						Active client conversations organized by account and thread.
					</p>
				</div>

				<div className="mt-8 space-y-3">
					{clientEmails.length === 0 ? (
						<div className="nak-card p-12 text-center">
							<Users className="h-10 w-10 text-[#5f6368] mx-auto mb-3 opacity-40" />
							<p className="text-sm font-semibold text-[#171717]">No client conversations yet</p>
							<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto">
								Emails from clients and external partners are automatically grouped here.
							</p>
						</div>
					) : (
						clientEmails.map((item) => (
							<div
								key={item.id}
								onClick={() => selectEmail(item.id)}
								className="nak-card p-4 flex items-center justify-between gap-4 hover:bg-[#f6f6f6] cursor-pointer transition-colors"
							>
								<div className="min-w-0">
									<p className="text-sm font-medium text-[#171717] truncate">{item.sender}</p>
									<p className="text-xs text-[#5f6368] mt-0.5 truncate">{item.subject}</p>
								</div>
								<span className="nak-label shrink-0">Client</span>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
