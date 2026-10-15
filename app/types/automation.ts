export interface AutoCampaign {
	id: string; name: string; status: "draft" | "active" | "paused" | "stopped"; mode: "draft_only" | "auto_send";
	sender_alias: string; sender_name: string; company: string; postal_address: string; brief: string; language: string;
	daily_cap: number; min_gap_min: number; max_gap_min: number; window_start: number; window_end: number; tz: string; days: string;
	max_followups: number; followup_gap_days: number; allow_links: number; permission_until: number | null; confirmed_legit: number;
	paused_reason: string | null;
	leadCounts?: Record<string, number>; totalLeads?: number; sent?: number; sentToday?: number; pendingApproval?: number; permissionActive?: boolean;
}
export interface AutoOverview {
	settings: { masterEnabled: boolean; changedBy: string; changedAt: number; globalDailyCap: number };
	campaigns: AutoCampaign[]; suppression: number; sentToday: number; writer: string;
}
export interface AutoReadiness { ok: boolean; errors: string[]; warnings: string[] }
export interface AutoApproval { id: string; campaign_id: string; lead_id: string; step: number; subject: string; body: string; to_email: string; from_alias: string; name: string | null; company: string | null }
export interface AutoLead { id: string; email: string; name: string | null; company: string | null; role: string | null; status: string; step: number; last_sent_at: number | null }
export interface AutoEvent { ts: number; type: string; detail: string }
export interface AutoImportResult { added: number; duplicates: number; suppressed: number; invalid: { email: string; reason: string }[]; capped: number }
export interface AutoPreview { to: string; subject?: string; text?: string; words?: number; problems?: string[] }
export interface AutoSender { alias: string; sentToday: number; rampCap: number; ageDays: number }
