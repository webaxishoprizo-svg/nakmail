import { Loader } from "@cloudflare/kumo";
import { Navigate, useLocation, useParams } from "react-router";
import { useMailboxes } from "~/queries/mailboxes";

const DESTINATIONS: Record<string, string> = {
	"/mailbox": "emails/inbox",
	"/inbox": "emails/inbox",
	"/priority": "priority",
	"/starred": "starred",
	"/drafts": "drafts",
	"/sent": "emails/sent",
	"/compose": "emails/inbox",
	"/search": "search",
	"/leads": "leads",
	"/follow-ups": "follow-ups",
	"/opportunities": "opportunities",
	"/projects": "projects",
	"/clients": "clients",
	"/finance": "finance",
	"/internal": "internal",
	"/analytics": "analytics",
	"/assistant": "assistant",
	"/api-access": "api-access",
	"/settings": "settings",
	"/automations": "automations",
};

export default function LegacyMailboxRedirect() {
	const location = useLocation();
	const { emailId } = useParams<{ emailId?: string }>();
	const { data: mailboxes, isFetched } = useMailboxes();
	const mailboxId = mailboxes?.[0]?.id;

	if (!isFetched) {
		return (
			<div className="flex h-screen items-center justify-center">
				<Loader size="lg" />
			</div>
		);
	}
	if (!mailboxId) return <Navigate to="/" replace />;

	const base = location.pathname.startsWith("/email/")
		? `emails/inbox?open=${encodeURIComponent(emailId ?? "")}`
		: DESTINATIONS[location.pathname] ?? "emails/inbox";
	const [path, extraSearch] = base.split("?");
	const params = new URLSearchParams(location.search);
	if (extraSearch) {
		for (const [key, value] of new URLSearchParams(extraSearch)) params.set(key, value);
	}
	if (location.pathname === "/compose") params.set("compose", "new");
	const search = params.toString();
	const to = `/mailbox/${encodeURIComponent(mailboxId)}/${path}${search ? `?${search}` : ""}`;

	return <Navigate to={to} replace />;
}
