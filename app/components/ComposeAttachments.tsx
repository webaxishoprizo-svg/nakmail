import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { formatBytes } from "~/lib/utils";
import { COMPOSE_ATTACHMENT_ACCEPT, MAX_COMPOSE_FILE_COUNT, MAX_COMPOSE_FILE_BYTES, MAX_COMPOSE_TOTAL_BYTES } from "~/lib/compose-attachments";
import type { ComposeAttachment } from "~/types/compose";

const PREVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

export default function ComposeAttachments({
	attachments,
	addAttachments,
	removeAttachment,
	disabled,
}: {
	attachments: ComposeAttachment[];
	addAttachments: (files: File[]) => Promise<void>;
	removeAttachment: (id: string) => void;
	disabled?: boolean;
}) {
	const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0);

	return (
		<div className="space-y-2.5">
			<div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed px-3 py-2.5 transition-colors ${disabled ? "border-[#e5e7eb] bg-white/40 opacity-60" : "border-[#d9dee5] bg-white/65 hover:border-[#aeb6c0]"}`}>
				<div className="flex min-w-0 items-center gap-2.5">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#f0f2f5] text-[#555e68]">
						<Paperclip className="size-4" />
					</div>
					<div className="min-w-0">
						<p className="text-xs font-medium text-[#252a30]">Add documents or images</p>
						<p className="text-[10px] text-[#858d96]">Draft files stay in this browser; sent files are kept by your email provider.</p>
						<p className="text-[11px] text-[#7a828b]">Up to 10 MB each · 20 MB total · {MAX_COMPOSE_FILE_COUNT} files</p>
					</div>
				</div>
				<label className={`inline-flex shrink-0 cursor-pointer items-center rounded-lg border border-[#e1e5ea] bg-white px-3 py-2 text-xs font-medium text-[#252a30] shadow-sm transition hover:bg-[#f8f9fa] focus-within:ring-2 focus-within:ring-[#171717]/20 ${disabled ? "pointer-events-none opacity-50" : ""}`}>
					Browse files
					<input
						type="file"
						multiple
						accept={COMPOSE_ATTACHMENT_ACCEPT}
						disabled={disabled}
						className="sr-only"
						onChange={(event) => {
							const files = Array.from(event.currentTarget.files ?? []);
							event.currentTarget.value = "";
							void addAttachments(files);
						}}
					/>
				</label>
			</div>

			{attachments.length > 0 && (
				<div className="space-y-2">
					<div className="flex items-center justify-between px-1 text-[11px] text-[#777f88]">
						<span>{attachments.length} {attachments.length === 1 ? "file" : "files"} attached</span>
						<span>{formatBytes(totalSize)} / {formatBytes(MAX_COMPOSE_TOTAL_BYTES)}</span>
					</div>
					<div className="grid gap-2 sm:grid-cols-2">
						{attachments.map((attachment) => {
							const previewImage = PREVIEW_IMAGE_TYPES.has(attachment.type);
							return (
								<div key={attachment.id} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[#e6e9ed] bg-white/80 px-2.5 py-2 shadow-[0_2px_8px_rgba(20,28,38,0.035)]">
									{previewImage && attachment.content ? (
										<img
											src={`data:${attachment.type};base64,${attachment.content}`}
											alt=""
											className="size-9 shrink-0 rounded-lg border border-[#eceff2] bg-[#f5f6f8] object-cover"
										/>
									) : (
										<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#f3f4f6] text-[#5d6670]">
											{attachment.type.startsWith("image/") ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
										</div>
									)}
									<div className="min-w-0 flex-1">
										<p className="truncate text-xs font-medium text-[#30363d]" title={attachment.filename}>{attachment.filename}</p>
											<p className={`mt-0.5 text-[10px] ${attachment.content ? "text-[#858d96]" : "text-[#b42318]"}`}>{attachment.content ? formatBytes(attachment.size) : "Missing from this browser · remove and reattach"}</p>
									</div>
									<button
										type="button"
										disabled={disabled}
										onClick={() => removeAttachment(attachment.id)}
										aria-label={`Remove ${attachment.filename}`}
										className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[#858d96] transition hover:bg-[#f2f3f5] hover:text-[#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/20 disabled:opacity-40"
									>
										<X className="size-3.5" />
									</button>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
