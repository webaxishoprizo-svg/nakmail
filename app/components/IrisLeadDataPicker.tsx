import { FileSpreadsheet, LoaderCircle, Link2, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import api from "~/services/api";
import type { IrisLeadData, IrisLeadDataSource } from "~/types/iris";

const MAX_FILE_BYTES = 1_500_000;

export default function IrisLeadDataPicker({
	value,
	onChange,
	disabled,
}: {
	value: IrisLeadData | null;
	onChange: (data: IrisLeadData | null, source?: IrisLeadDataSource) => void;
	disabled?: boolean;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [sheetUrl, setSheetUrl] = useState("");
	const [showSheetInput, setShowSheetInput] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const unavailable = disabled || busy;

	const loadCsv = async (csv: string, sourceName: string) => {
		setBusy(true);
		setError(null);
		try {
			const data = await api.irisLoadLeadData({ csv, sourceName });
			onChange(data, { csv });
			setShowSheetInput(false);
			setSheetUrl("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not read this lead sheet.");
		} finally {
			setBusy(false);
		}
	};

	const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!file) return;
		if (file.size > MAX_FILE_BYTES) {
			setError("Lead sheets must be 1.5 MB or smaller.");
			return;
		}
		try {
			const extension = file.name.split(".").pop()?.toLowerCase();
			if (!["csv", "xlsx", "xls"].includes(extension ?? "")) {
				throw new Error("Choose a CSV, XLS, or XLSX spreadsheet.");
			}
			let csv: string;
			if (extension === "xlsx" || extension === "xls") {
				const XLSX = await import("xlsx");
				const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", sheetRows: 5002 });
				const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
				if (!firstSheet) throw new Error("This workbook has no worksheet.");
				const ref = firstSheet["!ref"];
				if (!ref) throw new Error("The first worksheet is empty.");
				const range = XLSX.utils.decode_range(ref);
				range.s.r = 0;
				range.e.r = Math.min(range.e.r, 5001);
				range.e.c = Math.min(range.e.c, 99);
				firstSheet["!ref"] = XLSX.utils.encode_range(range);
				csv = XLSX.utils.sheet_to_csv(firstSheet);
			} else {
				csv = await file.text();
			}
			if (new TextEncoder().encode(csv).byteLength > MAX_FILE_BYTES) {
				throw new Error("The converted lead sheet is too large (limit 1.5 MB).");
			}
			await loadCsv(csv, file.name);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not read this spreadsheet.");
		}
	};

	const connectSheet = async (event: FormEvent) => {
		event.preventDefault();
		if (!sheetUrl.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const data = await api.irisLoadLeadData({ sheetUrl: sheetUrl.trim() });
			onChange(data, { sheetUrl: sheetUrl.trim() });
			setSheetUrl("");
			setShowSheetInput(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not connect to this Google Sheet.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-2">
			<input
				ref={fileInput}
				type="file"
				accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				className="sr-only"
				disabled={unavailable}
				onChange={onFileChange}
			/>

			{value ? (
				<div className="flex items-center gap-2.5 rounded-xl border border-[#e3e7eb] bg-white/75 px-3 py-2.5 shadow-[0_2px_8px_rgba(20,28,38,0.035)]">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#f1f3f5] text-[#4d5660]">
						<FileSpreadsheet className="size-4" />
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate text-xs font-medium text-[#30363d]" title={value.sourceName}>{value.sourceName}</p>
						<p className="mt-0.5 text-[11px] text-[#747d86]">
							{value.leads.length} lead{value.leads.length === 1 ? "" : "s"} ready
							{value.truncated ? ` · first ${value.leads.length} shared with Iris; campaign setup imports the full sheet` : ""}
							{value.invalid ? ` · ${value.invalid} invalid skipped` : ""}
						</p>
					</div>
					<button
						type="button"
						disabled={unavailable}
					onClick={() => { onChange(null); setError(null); }}
						className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[#858d96] transition hover:bg-[#f1f3f5] hover:text-[#171717] disabled:opacity-40"
						aria-label="Remove lead data from this chat"
						title="Remove lead data"
					>
						<X className="size-3.5" />
					</button>
				</div>
			) : (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							disabled={unavailable}
							onClick={() => fileInput.current?.click()}
							className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#e3e7eb] bg-white/70 px-2.5 text-[11px] font-medium text-[#4c555f] transition hover:bg-white hover:text-[#171717] disabled:opacity-50"
						>
							{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileSpreadsheet className="size-3.5" />}
							Upload Excel / CSV
						</button>
						<button
							type="button"
							disabled={unavailable}
							onClick={() => { setShowSheetInput((shown) => !shown); setError(null); }}
							className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#e3e7eb] bg-white/70 px-2.5 text-[11px] font-medium text-[#4c555f] transition hover:bg-white hover:text-[#171717] disabled:opacity-50"
						>
							<Link2 className="size-3.5" />
							Google Sheets
						</button>
					</div>

					{showSheetInput && (
						<form onSubmit={connectSheet} className="flex gap-2">
							<input
								type="url"
								value={sheetUrl}
								onChange={(event) => setSheetUrl(event.target.value)}
								placeholder="Paste a shareable Google Sheets link"
								aria-label="Google Sheets link"
								className="h-9 min-w-0 flex-1 rounded-lg border border-[#dfe3e8] bg-white px-2.5 text-xs text-[#30363d] outline-none placeholder:text-[#9aa1a8] focus:border-[#b4bbc3] focus:ring-2 focus:ring-[#171717]/10"
								disabled={unavailable}
							/>
							<button
								type="submit"
								disabled={unavailable || !sheetUrl.trim()}
								className="h-9 shrink-0 rounded-lg bg-[#171717] px-3 text-xs font-medium text-white transition hover:bg-[#333333] disabled:cursor-not-allowed disabled:bg-[#d4d7db]"
							>
								{busy ? "Loading…" : "Connect"}
							</button>
						</form>
					)}
					<p className="text-[10px] leading-4 text-[#8b939b]">Lead rows are sent with this chat. Iris stores them with a campaign only when you ask it to create one. Google Sheets must be shared for link viewing.</p>
				</div>
			)}
			{value && <p className="text-[10px] leading-4 text-[#8b939b]">If you ask Iris to create a campaign, the full spreadsheet is imported into campaign storage for scheduled sending.</p>}

			{error && <p className="text-xs leading-4 text-[#9a413a]" role="alert">{error}</p>}
		</div>
	);
}
