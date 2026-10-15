/** "From" picker. Shown only when the person may send as more than one address (admins: any alias). */
export default function FromSelect({
	senders,
	value,
	onChange,
	disabled,
}: {
	senders: string[];
	value?: string;
	onChange: (address: string) => void;
	disabled?: boolean;
}) {
	if (senders.length < 2) return null;
	return (
		<label className="block">
			<span className="text-sm font-medium text-kumo-default">From</span>
			<select
				value={value ?? senders[0]}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				className="mt-1 w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm text-kumo-default"
			>
				{senders.map((s) => <option key={s} value={s}>{s}</option>)}
			</select>
		</label>
	);
}
