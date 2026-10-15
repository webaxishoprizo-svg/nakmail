export interface IrisLead {
	email: string;
	name?: string;
	company?: string;
	role?: string;
	website?: string;
	notes?: string;
	extra?: Record<string, string>;
}

export interface IrisLeadData {
	sourceName: string;
	total: number;
	invalid: number;
	truncated: boolean;
	leads: IrisLead[];
}

export interface IrisEmailAction {
	type: "send" | "draft";
	to: string[];
	subject: string;
	body: string;
	html: string;
}

export interface IrisAutomationAction {
	campaign: {
		name: string;
		sender_name: string;
		company: string;
		postal_address: string;
		brief: string;
		language?: string;
		mode: "draft_only" | "auto_send";
		daily_cap: number;
		min_gap_min: number;
		max_gap_min: number;
		window_start: number;
		window_end: number;
		days: number[];
		max_followups: number;
		followup_gap_days: number;
		allow_links: boolean;
	};
}

export interface IrisLeadDataSource {
	csv?: string;
	sheetUrl?: string;
}

export interface IrisChatResponse {
	reply: string;
	action?: IrisEmailAction;
	automation?: IrisAutomationAction;
	automationPending?: boolean;
}
