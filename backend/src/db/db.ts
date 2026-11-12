import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function initDb(): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  await pool.query(sql);
  // conversations created before the expiry columns existed: start their clock at their first customer message
  await pool.query(
    `UPDATE conversations c
        SET first_message_at = m.t, expires_at = m.t + make_interval(secs => $1)
       FROM (SELECT conversation_id, min(created_at) AS t FROM messages WHERE role='customer' GROUP BY conversation_id) m
      WHERE m.conversation_id = c.id AND c.expires_at IS NULL`,
    [config.sessionTtlHours * 3600],
  );
}
