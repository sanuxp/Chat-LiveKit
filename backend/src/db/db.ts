import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function initDb(): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  await pool.query(sql);
}
