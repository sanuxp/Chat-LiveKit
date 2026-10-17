import { pool } from "../db/db.js";
import { getHandoff } from "../conversations.js";
import { toolOptions } from "../tools/registry.js";
import { armFallback } from "./handoff.js";

/** After a restart: re-arm fallback timers for conversations still waiting, . */
export async function resumeWaiting(): Promise<void> {
  const rows = (await pool.query("SELECT id FROM conversations WHERE status='waiting' AND deleted_at IS NULL")).rows;
  await Promise.all(rows.map(async (row) => {
    const h = await getHandoff(row.id).catch(() => null);
    if (!h || h.status !== "waiting") return;
    const opts = toolOptions(h.channel) ?? {};
    const total = Number(opts.fallback_after_seconds ?? 300);
    const remaining = Math.max(0, total - (Date.now() - h.updated_at) / 1000);
    armFallback(row.id, remaining, typeof opts.fallback_tool === "string" ? opts.fallback_tool : undefined);
  }));
}
