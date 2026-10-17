import { randomUUID } from "node:crypto";
import { pool } from "./db/db.js";
import { agentIdentity, publish, type WireMessage } from "./realtime/livekit.js";

export type HandoffStatus = "ai" | "waiting" | "assigned" | "escalated_external" | "closed";
export interface HandoffState {
  status: HandoffStatus;
  agent_id: string | null;
  channel: string | null;
  reason: string | null;
  summary: string | null;
  ai_note?: string | null; // one-shot instruction injected into the AI's next turn
  updated_at: number;
}

const COLUMN: Record<string, string> = {
  status: "status", agent_id: "assigned_agent", channel: "channel", reason: "reason", summary: "summary", ai_note: "ai_note",
};

export async function getHandoff(conversationId: string): Promise<HandoffState> {
  const r = await pool.query(
    `SELECT status, assigned_agent, channel, reason, summary, ai_note, handoff_updated_at
       FROM conversations WHERE id=$1 AND deleted_at IS NULL`,
    [conversationId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("conversation not found");
  return {
    status: row.status, agent_id: row.assigned_agent, channel: row.channel, reason: row.reason,
    summary: row.summary, ai_note: row.ai_note, updated_at: new Date(row.handoff_updated_at).getTime(),
  };
}

export async function agentDisplayName(username: string | null): Promise<string | null> {
  if (!username) return null;
  const r = await pool.query("SELECT display_name FROM agents WHERE username=$1", [username]);
  return r.rows[0]?.display_name ?? username;
}

/** Write hand-off state and tell everyone in the room (the widget and console react to "state"). */
export async function setHandoff(conversationId: string, update: Partial<HandoffState>): Promise<HandoffState> {
  const sets: string[] = [];
  const vals: unknown[] = [conversationId];
  for (const [k, v] of Object.entries(update)) {
    const col = COLUMN[k];
    if (!col) continue;
    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  }
  if (sets.length) {
    await pool.query(
      `UPDATE conversations SET ${sets.join(", ")}, handoff_updated_at=now(), updated_at=now() WHERE id=$1`,
      vals,
    );
  }
  const next = await getHandoff(conversationId);
  await publish(conversationId, { t: "state", status: next.status, agent: await agentDisplayName(next.agent_id) });
  return next;
}

export async function getCustomerRef(conversationId: string): Promise<string> {
  const r = await pool.query(
    "SELECT cu.external_ref FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=$1",
    [conversationId],
  );
  return r.rows[0]?.external_ref ?? "";
}

// --- messages --------------------------------------------------------------------------------

export interface NewMessage {
  id?: string;
  role: WireMessage["role"];
  sender?: string | null; // display name for agents
  kind?: "text" | "notice";
  internal?: boolean; // agent-only
  body: string;
}

function toWire(row: any): WireMessage {
  return {
    id: row.id, role: row.role, name: row.sender, kind: row.kind, internal: row.internal,
    body: row.body, at: new Date(row.created_at).toISOString(),
  };
}

/** Store a message and push it to the room. Internal messages go only to the assigned agent. */
export async function addMessage(conversationId: string, m: NewMessage): Promise<WireMessage> {
  const r = await pool.query(
    `INSERT INTO messages (id, conversation_id, role, sender, kind, internal, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, role, sender, kind, internal, body, created_at`,
    [m.id ?? randomUUID(), conversationId, m.role, m.sender ?? null, m.kind ?? "text", !!m.internal, m.body],
  );
  await pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
  const wire = toWire(r.rows[0]);
  let to: string[] | undefined;
  if (wire.internal) {
    const h = await getHandoff(conversationId).catch(() => null);
    if (!h?.agent_id) return wire; // nobody may see it live; the agent who accepts loads it from history
    to = [agentIdentity(h.agent_id)];
  }
  await publish(conversationId, { t: "message", message: wire }, to);
  return wire;
}

export const sendNotice = (conversationId: string, body: string, internal = false) =>
  addMessage(conversationId, { role: "system", kind: "notice", body, internal });

/** Last `limit` messages, oldest first. Customers never get internal messages. */
export async function getHistory(conversationId: string, limit: number, includeInternal: boolean): Promise<WireMessage[]> {
  const r = await pool.query(
    `SELECT id, role, sender, kind, internal, body, created_at FROM (
       SELECT * FROM messages WHERE conversation_id=$1 AND ($3 OR NOT internal) ORDER BY seq DESC LIMIT $2
     ) t ORDER BY seq ASC`,
    [conversationId, limit, includeInternal],
  );
  return r.rows.map(toWire);
}

/** Plain-text transcript for emails/webhooks. Agent-only notes and system notices are left out. */
export async function getTranscript(conversationId: string, limit = 200): Promise<string> {
  const msgs = await getHistory(conversationId, limit, false);
  return msgs
    .filter((x) => x.kind !== "notice")
    .map((x) => `${x.role === "ai" ? "Assistant" : x.role === "customer" ? "Customer" : "Agent"}: ${x.body}`)
    .join("\n");
}
