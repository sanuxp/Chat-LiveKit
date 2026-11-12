import { config } from "../config.js";
import { sendNotice, setHandoff } from "../conversations.js";
import { pool } from "../db/db.js";
import { deleteRoom } from "../realtime/livekit.js";

/**
 * Session lifetime. A conversation expires `SESSION_TTL_HOURS` after the customer's first message (fixed window).
 * Expired conversations are closed (transcript kept, see TRANSCRIPT_RETENTION_DAYS) and the customer's next visit starts
 * a fresh one. A conversation with a human (waiting / assigned) is never cut off: it is closed as soon as that ends.
 */

const LIVE_HANDOFF = ["waiting", "assigned"];

export async function isExpired(conversationId: string): Promise<boolean> {
  const r = await pool.query("SELECT (expires_at IS NOT NULL AND expires_at <= now()) AS due FROM conversations WHERE id=$1 AND deleted_at IS NULL", [conversationId]);
  return !!r.rows[0]?.due;
}

/** Close an expired conversation: tell everyone in the room, keep the transcript, drop calls. Safe to call twice. */
export async function closeExpired(conversationId: string): Promise<void> {
  const r = await pool.query(
    "UPDATE conversations SET closed_at=now(), closed_reason='expired' WHERE id=$1 AND status <> 'closed' AND deleted_at IS NULL RETURNING id",
    [conversationId],
  );
  if (!r.rowCount) return;
  await setHandoff(conversationId, { status: "closed", agent_id: null });
  await sendNotice(conversationId, "This conversation has ended because its time limit was reached. You can start a new one.");
  // let clients receive the events above, then end any call that is still running in the room
  setTimeout(() => void deleteRoom(conversationId), 3000).unref?.();
  console.log(JSON.stringify({ msg: "conversation expired", conversationId }));
}

/** Close the conversation if it is due and not in a live human hand-off. Returns true when it was closed. */
export async function closeIfExpired(conversationId: string): Promise<boolean> {
  const r = await pool.query("SELECT status, (expires_at IS NOT NULL AND expires_at <= now()) AS due FROM conversations WHERE id=$1 AND deleted_at IS NULL", [conversationId]);
  const row = r.rows[0];
  if (!row?.due || row.status === "closed" || LIVE_HANDOFF.includes(row.status)) return false;
  await closeExpired(conversationId);
  return true;
}

async function sweep(): Promise<void> {
  const due = await pool.query(
    `SELECT id FROM conversations
      WHERE expires_at <= now() AND status IN ('ai', 'escalated_external') AND deleted_at IS NULL
      LIMIT 200`,
  );
  for (const row of due.rows) await closeExpired(row.id).catch((e) => console.error("close expired failed:", e?.message));

  if (config.transcriptRetentionDays > 0) {
    const old = await pool.query(
      `UPDATE conversations SET deleted_at = now()
        WHERE status = 'closed' AND closed_at < now() - make_interval(days => $1) AND deleted_at IS NULL RETURNING id`,
      [config.transcriptRetentionDays],
    );
    if (old.rowCount) {
      await pool.query("DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])", [old.rows.map((r) => r.id)]);
      console.log(JSON.stringify({ msg: "transcripts purged", conversations: old.rowCount }));
    }
  }
}

export function startSessionSweeper(): void {
  const run = () => sweep().catch((e) => console.error("session sweep failed:", e?.message));
  void run(); // also right after a restart
  setInterval(run, Math.max(1, config.sessionSweepSeconds) * 1000).unref?.();
}
