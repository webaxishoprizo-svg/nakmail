import { FolderKanban } from "lucide-react";

export default function ProjectsRoute() {
	return (
		<div className="h-full overflow-y-auto bg-white px-6 py-8 md:px-10 font-sans">
			<div className="max-w-3xl mx-auto">
				<div className="pb-6 border-b border-[#e5e5e5]">
					<div className="flex items-center gap-2">
						<FolderKanban className="h-5 w-5 text-[#315f9f]" />
						<p className="nak-label">Work & Delivery</p>
					</div>
					<h2 className="nak-display text-4xl mt-2 text-[#171717]">Projects</h2>
					<p className="text-sm text-[#5f6368] mt-1.5">
						Project threads group here once email threads are linked to ongoing delivery work.
					</p>
				</div>

				<div className="mt-8 nak-card p-12 text-center">
					<FolderKanban className="h-10 w-10 text-[#5f6368] mx-auto mb-3 opacity-40" />
					<p className="text-sm font-semibold text-[#171717]">No project links yet</p>
					<p className="text-xs text-[#5f6368] mt-1 max-w-sm mx-auto">
						Tag conversations or link projects from your inbox to view dedicated client delivery streams.
					</p>
				</div>
			</div>
		</div>
	);
}
