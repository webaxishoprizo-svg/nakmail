import { useParams } from "react-router";
import { Wallet } from "lucide-react";
import { useEmails } from "~/queries/emails";
import { useUIStore } from "~/hooks/useUIStore";

export default function FinanceRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: emailData } = useEmails(mailboxId, { limit: "50" });
	const { selectEmail } = useUIStore();

	const emails = emailData?.emails ?? [];
	const financeEmails = emails.filter(
		(e) =>
			e.subject?.toLowerCase().includes("invoice") ||
			e.subject?.toLowerCase().includes("receipt") ||
			e.subject?.toLowerCase().includes("payment") ||
			e.subject?.toLowerCase().includes("billing") ||
			e.subject?.toLowerCase().includes("statement"),
	);

	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-3xl mx-auto">
				<div className="pb-6 border-b border-[#e5e5e5]">
					<div className="flex items-center gap-2">
						<Wallet className="h-5 w-5 text-[#315f9f]" />
						<p className="nak-label">Finance & Accounts</p>
					</div>
					<h2 className="nak-display text-4xl mt-2 text-[#171717]">Finance</h2>
					<p className="text-sm text-[#5f6368] mt-1.5">
						Invoices, receipts, and payment conversations extracted from your inbox.
					</p>
				</div>

				<div className="mt-8 space-y-3">
					{financeEmails.length === 0 ? (
						<div className="nak-card p-12 text-center">
							<Wallet className="h-10 w-10 text-[#5f6368] mx-auto mb-3 opacity-40" />
							<p className="text-sm font-semibold text-[#171717]">No finance emails</p>
							<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto">
								Invoices, wire receipts, and payment notifications from your Zoho mailbox appear here.
							</p>
						</div>
					) : (
						financeEmails.map((item) => (
							<div
								key={item.id}
								onClick={() => selectEmail(item.id)}
								className="nak-card p-4 flex items-center justify-between gap-4 hover:bg-[#f6f6f6] cursor-pointer transition-colors"
							>
								<div className="min-w-0">
									<p className="text-sm font-medium text-[#171717] truncate">{item.sender}</p>
									<p className="text-xs text-[#5f6368] mt-0.5 truncate">{item.subject}</p>
								</div>
								<span className="nak-label shrink-0">Invoice / Billing</span>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
