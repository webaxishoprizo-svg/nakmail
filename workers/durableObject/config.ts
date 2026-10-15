// Small, strongly consistent application records stored in SQLite.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

export class ConfigDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS app_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
	}

	async getValue(key: string): Promise<string | null> {
		const row = [...this.ctx.storage.sql.exec(
			"SELECT value FROM app_config WHERE key = ?1 LIMIT 1",
			key,
		)][0] as { value: string } | undefined;
		return row?.value ?? null;
	}

	async hasValue(key: string): Promise<boolean> {
		return [...this.ctx.storage.sql.exec(
			"SELECT 1 FROM app_config WHERE key = ?1 LIMIT 1",
			key,
		)].length > 0;
	}

	async putValue(key: string, value: string): Promise<void> {
		this.ctx.storage.sql.exec(
			`INSERT INTO app_config (key, value, updated_at) VALUES (?1, ?2, ?3)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			key,
			value,
			new Date().toISOString(),
		);
	}

	async putValueIfAbsent(key: string, value: string): Promise<boolean> {
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?1, ?2, ?3)",
			key,
			value,
			new Date().toISOString(),
		);
		const row = [...this.ctx.storage.sql.exec("SELECT changes() AS changed")][0] as { changed: number } | undefined;
		return Number(row?.changed ?? 0) > 0;
	}

	async deleteValue(key: string): Promise<boolean> {
		this.ctx.storage.sql.exec("DELETE FROM app_config WHERE key = ?1", key);
		const row = [...this.ctx.storage.sql.exec("SELECT changes() AS changed")][0] as { changed: number } | undefined;
		return Number(row?.changed ?? 0) > 0;
	}

	async listKeys(prefix: string, limit = 1000): Promise<string[]> {
		const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 5000);
		const rows = [...this.ctx.storage.sql.exec(
			"SELECT key FROM app_config WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key LIMIT ?2",
			prefix,
			boundedLimit,
		)] as { key: string }[];
		return rows.map((row) => row.key);
	}
}
