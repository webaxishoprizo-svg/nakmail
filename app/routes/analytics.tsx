import { useParams } from "react-router";
import { BarChart3 } from "lucide-react";
import { useMailboxStats } from "~/queries/iris";
import { useEmails } from "~/queries/emails";

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
	const pct = max > 0 ? (value / max) * 100 : 0;
	return (
		<div className="flex items-center gap-3 py-2">
			<span className="text-xs text-[#5f6368] w-32 truncate">{label}</span>
			<div className="flex-1 h-3.5 bg-[#f1f3f4] rounded-full overflow-hidden">
				<div
					className="h-full bg-[#171717] rounded-full transition-all duration-300"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="text-xs font-semibold tabular-nums w-8 text-right text-[#171717]">
				{value}
			</span>
		</div>
	);
}

export default function AnalyticsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: stats } = useMailboxStats(mailboxId);
	const { data: emailData } = useEmails(mailboxId, { limit: "100" });

	const emails = emailData?.emails ?? [];
	const hotCount = stats?.leads.hot ?? emails.filter((e) => e.level === "hot").length;
	const warmCount = stats?.leads.warm ?? emails.filter((e) => e.level === "warm").length;
	const sentToday = stats?.today.sent ?? 0;
	const receivedToday = stats?.today.received ?? emails.length;

	const cards: [string, string | number, string?][] = [
		["Total Emails Processed", emails.length, "Across connected folders"],
		["High-Priority Enquiries", hotCount + warmCount, "Extracted by Iris AI"],
		["Emails Received Today", receivedToday, "Synced from Zoho"],
		["Emails Sent Today", sentToday, "Outbound responses"],
		["Hot Leads", hotCount, "Scores 70+"],
		["Warm Enquiries", warmCount, "Scores 40–69"],
	];

	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-4xl mx-auto">
				{/* Header */}
				<div className="pb-6 border-b border-[#e5e5e5]">
					<div className="flex items-center gap-2">
						<BarChart3 className="h-5 w-5 text-[#315f9f]" />
						<p className="nak-label">Performance & Velocity</p>
					</div>
					<h2 className="nak-display text-4xl mt-2 text-[#171717]">Analytics</h2>
					<p className="text-sm text-[#5f6368] mt-1.5 leading-relaxed">
						Sales and email communication performance based on active Zoho mailbox data.
					</p>
				</div>

				{/* 6 Metric Cards */}
				<div className="grid grid-cols-2 lg:grid-cols-3 gap-3.5 mt-8">
					{cards.map(([label, value, hint]) => (
						<div key={label} className="nak-card px-5 py-4">
							<p className="nak-label">{label}</p>
							<p className="nak-display text-3xl mt-2 tabular-nums text-[#171717]">{value}</p>
							{hint && <p className="text-[11px] text-[#5f6368] mt-1">{hint}</p>}
						</div>
					))}
				</div>

				{/* Breakdown visual charts */}
				<div className="grid md:grid-cols-2 gap-4 mt-8">
					<div className="nak-card p-5">
						<p className="nak-label mb-3">Lead Intent Breakdown</p>
						<Bar label="High Intent (Hot)" value={hotCount} max={Math.max(1, hotCount + warmCount)} />
						<Bar label="Medium Intent (Warm)" value={warmCount} max={Math.max(1, hotCount + warmCount)} />
						<Bar label="General Inquiries" value={Math.max(0, emails.length - hotCount - warmCount)} max={Math.max(1, emails.length)} />
					</div>

					<div className="nak-card p-5">
						<p className="nak-label mb-3">Activity Distribution</p>
						<Bar label="Inbox Volume" value={receivedToday} max={Math.max(1, receivedToday + sentToday)} />
						<Bar label="Sent Messages" value={sentToday} max={Math.max(1, receivedToday + sentToday)} />
						<Bar label="Active Leads" value={hotCount} max={Math.max(1, receivedToday + sentToday)} />
					</div>
				</div>
			</div>
		</div>
	);
}
