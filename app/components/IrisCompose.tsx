import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import api from "~/services/api";
import IrisLogo from "~/components/IrisLogo";

interface Props {
	senderName?: string;
	replyTo?: { subject?: string; body?: string; from?: string };
	hasSubject: boolean;
	/** Insert the draft at the top of the message (and set the subject if it is still empty). */
	onUse: (draft: { subject: string; html: string }) => void;
	disabled?: boolean;
}

/** "Write with iRIS": describe the email in a sentence, preview the draft, then insert it. */
export default function IrisCompose({ senderName, replyTo, hasSubject, onUse, disabled }: Props) {
	const [open, setOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState<{ subject: string; text: string; html: string } | null>(null);

	const generate = async () => {
		if (!prompt.trim() || busy) return;
		setBusy(true); setError(null);
		try {
			setDraft(await api.irisCompose({ prompt: prompt.trim(), senderName, replyTo }));
		} catch (err) {
			setError(err instanceof Error ? err.message : "iRIS could not write this.");
		} finally { setBusy(false); }
	};

	if (!open) {
		return (
			<button type="button" onClick={() => setOpen(true)} disabled={disabled}
				className="inline-flex items-center gap-1.5 text-sm font-medium text-kumo-link hover:text-kumo-link-hover">
				<IrisLogo size={17} /> Write with iRIS
			</button>
		);
	}

	return (
		<div className="rounded-lg border border-kumo-line p-3 space-y-2">
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium text-kumo-default flex items-center gap-1.5"><IrisLogo size={17} /> iRIS</span>
				<button type="button" onClick={() => { setOpen(false); setDraft(null); setError(null); }} className="text-xs text-kumo-subtle">Close</button>
			</div>
			<textarea
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
				rows={2}
				maxLength={4000}
				placeholder="e.g. Thank them for their enquiry and offer a call on Thursday"
				className="w-full resize-none rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm text-kumo-default"
			/>
			{error && <div className="text-xs text-kumo-danger" role="alert">{error}</div>}
			{draft && (
				<div className="rounded-md bg-kumo-tint p-2 text-sm text-kumo-default space-y-1">
					{draft.subject && <div className="font-medium">{draft.subject}</div>}
					<div className="whitespace-pre-wrap">{draft.text}</div>
				</div>
			)}
			<div className="flex gap-2">
				<Button type="button" size="sm" variant={draft ? "secondary" : "primary"} loading={busy} onClick={generate} disabled={!prompt.trim()}>
					{draft ? "Rewrite" : "Write"}
				</Button>
				{draft && (
					<Button type="button" size="sm" variant="primary"
						onClick={() => { onUse({ subject: hasSubject ? "" : draft.subject, html: draft.html }); setDraft(null); setPrompt(""); setOpen(false); }}>
						Use this draft
					</Button>
				)}
			</div>
		</div>
	);
}
