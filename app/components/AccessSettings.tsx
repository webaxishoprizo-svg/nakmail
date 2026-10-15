import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useMemo, useState } from "react";
import { useAddAssignment, useAssignments, useRemoveAssignment } from "~/queries/access";

/** Admin only: assign Google accounts to aliases. Each assigned account sees only that alias's mail. */
export default function AccessSettings() {
	const toast = useKumoToastManager();
	const { data, isLoading, isError } = useAssignments(true);
	const add = useAddAssignment();
	const remove = useRemoveAssignment();
	const [alias, setAlias] = useState("");
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string | null>(null);

	const byAlias = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const a of data?.assignments ?? []) map.set(a.alias, [...(map.get(a.alias) ?? []), a.email]);
		return [...map.entries()];
	}, [data]);

	const handleAdd = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		try {
			await add.mutateAsync({ email: email.trim(), alias: alias.trim() });
			toast.add({ title: "Access granted" });
			setEmail("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save");
		}
	};

	const handleRemove = async (a: string, g: string) => {
		if (!window.confirm(`Remove ${g} from ${a}? They will lose access immediately.`)) return;
		try {
			await remove.mutateAsync({ email: g, alias: a });
			toast.add({ title: "Access removed" });
		} catch {
			toast.add({ title: "Failed to remove access", variant: "error" });
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-1">
				<span className="text-sm font-medium text-kumo-default">Alias access</span>
				<Badge variant="secondary">Admin</Badge>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Give a Google account its own alias mailbox. When that person signs in with Google they see only the mail
				received by, and sent from, that alias. Nothing else.
			</p>

			<form onSubmit={handleAdd} className="space-y-3">
				<Input
					label="Alias address"
					type="email"
					placeholder={`sales@${(data?.mainMailbox ?? "example.com").split("@")[1] ?? "example.com"}`}
					value={alias}
					onChange={(e) => setAlias(e.target.value)}
					list="alias-suggestions"
					required
				/>
				<datalist id="alias-suggestions">
					{(data?.suggestions ?? []).map((s) => <option key={s} value={s} />)}
				</datalist>
				<Input
					label="Google account"
					type="email"
					placeholder="person@gmail.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
				{error && <p className="text-xs text-kumo-danger" role="alert">{error}</p>}
				<Button type="submit" variant="primary" icon={<PlusIcon size={16} />} loading={add.isPending}>
					Assign
				</Button>
			</form>

			<div className="mt-5">
				{isLoading ? (
					<div className="flex justify-center py-4"><Loader size="sm" /></div>
				) : isError ? (
					<p className="text-xs text-kumo-danger">Could not load assignments.</p>
				) : byAlias.length === 0 ? (
					<p className="text-xs text-kumo-subtle">No aliases assigned yet.</p>
				) : (
					<div className="rounded-lg border border-kumo-line overflow-hidden">
						{byAlias.map(([a, people], i) => (
							<div key={a} className={`px-3 py-2 ${i > 0 ? "border-t border-kumo-line" : ""}`}>
								<div className="text-sm font-medium text-kumo-default break-all">{a}</div>
								{people.map((g) => (
									<div key={g} className="flex items-center justify-between gap-2 py-1">
										<span className="text-xs text-kumo-subtle break-all">{g}</span>
										<Button
											variant="ghost"
											size="sm"
											shape="square"
											icon={<TrashIcon size={14} />}
											aria-label={`Remove ${g} from ${a}`}
											onClick={() => handleRemove(a, g)}
										/>
									</div>
								))}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
