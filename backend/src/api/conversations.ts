import type { FastifyInstance } from "fastify";
import { enqueueAiReply } from "../ai/agent.js";
import { addMessage, agentDisplayName, getHandoff, getHistory } from "../conversations.js";
import { pool } from "../db/db.js";
import { httpError, verifyToken, type Claims } from "./auth.js";

const MAX_BODY = 4000;

/** Customers may use only their own conversation; agents only conversations assigned to them. */
async function authorize(claims: Claims, conversationId: string): Promise<{ status: string; assigned: string | null }> {
  const r = await pool.query(
    "SELECT status, assigned_agent, customer_id FROM conversations WHERE id=$1 AND deleted_at IS NULL",
    [conversationId],
  );
  const c = r.rows[0];
  if (!c) throw httpError(404, "Conversation not found");
  if (claims.role === "customer" && (claims.sub !== c.customer_id || claims.conv !== conversationId)) throw httpError(404, "Conversation not found");
  if (claims.role === "agent" && !(c.status === "assigned" && c.assigned_agent === claims.sub)) throw httpError(403, "Not assigned to you");
  return { status: c.status, assigned: c.assigned_agent };
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // Current state + stored history. Clients call this after connecting to the LiveKit room and merge by message id.
  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    const claims = verifyToken(req);
    const conv = await authorize(claims, req.params.id);
    const h = await getHandoff(req.params.id);
    return {
      status: conv.status,
      agent: await agentDisplayName(h.agent_id),
      messages: await getHistory(req.params.id, 200, claims.role === "agent"),
    };
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => {
    const claims = verifyToken(req);
    const conv = await authorize(claims, req.params.id);
    const body = String(((req.body ?? {}) as { body?: unknown }).body ?? "").trim();
    if (!body) throw httpError(400, "body required");
    if (body.length > MAX_BODY) throw httpError(400, `body too long (max ${MAX_BODY})`);
    if (conv.status === "closed") throw httpError(409, "Conversation has ended");

    if (claims.role === "customer") {
      const msg = await addMessage(req.params.id, { role: "customer", body });
      enqueueAiReply(req.params.id, msg.id); // no-op unless the AI is allowed to reply in the current state
      return { id: msg.id };
    }
    const msg = await addMessage(req.params.id, { role: "agent", sender: await agentDisplayName(claims.sub), body });
    return { id: msg.id };
  });
}
