import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useMe() {
	return useQuery({ queryKey: queryKeys.me, queryFn: () => api.getMe(), staleTime: 5 * 60_000 });
}

/** Sync the signed-in admin's Zoho account, then refresh all mailbox views it feeds. */
export function useSyncZoho() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.syncZoho(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["folders"] });
			qc.invalidateQueries({ queryKey: ["stats"] });
		},
	});
}

/** Addresses this person may send from in a mailbox (admins: any alias). */
export function useSenders(mailboxId?: string) {
	return useQuery({
		queryKey: queryKeys.senders(mailboxId ?? ""),
		queryFn: () => api.getSenders(mailboxId!),
		enabled: !!mailboxId,
		staleTime: 5 * 60_000,
	});
}

export function useAssignments(enabled: boolean) {
	return useQuery({ queryKey: queryKeys.assignments, queryFn: () => api.listAssignments(), enabled });
}

/** After any change the mailbox list and config (which drives the home page) must be refreshed. */
function useRefreshAccess() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: queryKeys.assignments });
		qc.invalidateQueries({ queryKey: ["senders"] });
		qc.invalidateQueries({ queryKey: queryKeys.config });
		qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
	};
}

export function useAddAssignment() {
	const refresh = useRefreshAccess();
	return useMutation({
		mutationFn: ({ email, alias }: { email: string; alias: string }) => api.addAssignment(email, alias),
		onSuccess: refresh,
	});
}

export function useRemoveAssignment() {
	const refresh = useRefreshAccess();
	return useMutation({
		mutationFn: ({ email, alias }: { email: string; alias: string }) => api.removeAssignment(email, alias),
		onSuccess: refresh,
	});
}
