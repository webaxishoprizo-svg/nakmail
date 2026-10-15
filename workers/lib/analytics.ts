// Send/receive counts per day in the business timezone. Pure functions.
export interface ActivityRow { folder_id: string; date: string }
export interface DayCount { date: string; sent: number; received: number }
export interface Activity {
	timezone: string; today: DayCount; yesterday: DayCount; last7: { sent: number; received: number }; byDay: DayCount[];
}

export function dayKey(d: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Start of the look-back window (UTC ISO) that safely covers 7 local days in any timezone. */
export const activitySince = (now: Date): string => new Date(now.getTime() - 9 * 86_400_000).toISOString();

export function summarizeActivity(rows: ActivityRow[], timeZone: string, now: Date): Activity {
	const days: DayCount[] = [];
	for (let i = 6; i >= 0; i--) days.push({ date: dayKey(new Date(now.getTime() - i * 86_400_000), timeZone), sent: 0, received: 0 });
	const idx = new Map(days.map((d, i) => [d.date, i]));
	for (const r of rows) {
		const t = new Date(r.date);
		if (Number.isNaN(t.getTime())) continue;
		const i = idx.get(dayKey(t, timeZone));
		if (i === undefined) continue;
		if (r.folder_id === "sent") days[i].sent++;
		else if (r.folder_id === "inbox") days[i].received++;
	}
	return {
		timezone: timeZone,
		today: days[6], yesterday: days[5],
		last7: { sent: days.reduce((n, d) => n + d.sent, 0), received: days.reduce((n, d) => n + d.received, 0) },
		byDay: days,
	};
}
