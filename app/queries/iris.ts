import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";

/** Hot/Warm lead counts and today's send/receive numbers for a mailbox. */
export function useMailboxStats(mailboxId?: string) {
	return useQuery({
		queryKey: ["stats", mailboxId ?? ""],
		queryFn: () => api.getStats(mailboxId!),
		enabled: !!mailboxId,
		staleTime: 30_000,
		refetchInterval: 60_000,
	});
}
