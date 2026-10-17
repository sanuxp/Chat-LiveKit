import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getHandoff, getHistory } from "../conversations.js";
import { getProfileByConversation, resolveProfile, storedFromRow } from "../customer/profile.js";
import { pool } from "../db/db.js";
import { agentIdentity, mintToken } from "../realtime/livekit.js";
import { assignToAgent, resolveConversation, setPresence } from "../routing/agents.js";
import { hashPassword, httpError, requireAgent, signToken, verifyPassword } from "./auth.js";

const DUMMY_HASH = hashPassword("not-a-real-password");

async function findConversation(id: string) {
  const r = await pool.query("SELECT id, status, assigned_agent FROM conversations WHERE id=$1 AND deleted_at IS NULL", [id]);
  if (!r.rows[0]) throw httpError(404, "Conversation not found");
  return r.rows[0] as { id: string; status: string; assigned_agent: string | null };
}

async function joinInfo(conversationId: string, username: string) {
  const h = await getHandoff(conversationId);
  const name = (await pool.query("SELECT display_name FROM agents WHERE username=$1", [username])).rows[0]?.display_name ?? username;
  return {
    status: "assigned",
    reason: h.reason,
    summary: h.summary,
    customer: await getProfileByConversation(conversationId),
    livekitUrl: config.livekitPublicUrl,
    livekitToken: await mintToken({ conversationId, identity: agentIdentity(username), name, role: "agent" }),
    features: { voice: config.enableVoice, video: config.enableVideo },
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/agent/login", async (req) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const r = await pool.query("SELECT username, display_name, password_hash FROM agents WHERE username=$1", [String(username ?? "")]);
    const a = r.rows[0];
    // verify against a dummy hash when the user is unknown, so timing doesn't reveal which usernames exist
    const ok = verifyPassword(String(password ?? ""), a?.password_hash ?? DUMMY_HASH);
    if (!a || !ok) throw httpError(401, "Invalid username or password");
    return { username: a.username, displayName: a.display_name, token: signToken({ role: "agent", sub: a.username }) };
  });

  app.post("/api/agent/presence", async (req) => {
    const { username } = await requireAgent(req);
    const { online } = (req.body ?? {}) as { online?: boolean };
    if (typeof online !== "boolean") throw httpError(400, "online (boolean) required");
    await setPresence(username, online);
    return { online };
  });

  app.get("/api/agent/conversations", async (req) => {
    const { username } = await requireAgent(req);
    const rows = (
      await pool.query(
        `SELECT c.id, c.status, c.assigned_agent, c.reason, c.summary, c.updated_at, cu.name, cu.email, cu.phone, cu.metadata
           FROM conversations c JOIN customers cu ON cu.id = c.customer_id
          WHERE c.deleted_at IS NULL AND (c.status='waiting' OR (c.status='assigned' AND c.assigned_agent=$1))
          ORDER BY c.updated_at ASC`,
        [username],
      )
    ).rows;
    return {
      conversations: rows.map((r) => ({
        id: r.id, status: r.status, assignedAgent: r.assigned_agent, reason: r.reason, summary: r.summary,
        updatedAt: r.updated_at, customer: resolveProfile(storedFromRow(r)),
      })),
    };
  });

  // Read-only look at a waiting conversation (or one of your own): AI summary + the whole transcript.
  // Nothing is assigned and the agent does not join the LiveKit room until they accept.
  app.get<{ Params: { id: string } }>("/api/agent/conversations/:id", async (req) => {
    const { username } = await requireAgent(req);
    const conv = await findConversation(req.params.id);
    const mine = conv.status === "assigned" && conv.assigned_agent === username;
    if (conv.status !== "waiting" && !mine) throw httpError(409, conv.status === "assigned" ? "Conversation was taken by someone else" : "Conversation is no longer waiting");
    const h = await getHandoff(conv.id);
    return {
      status: conv.status, mine, reason: h.reason, summary: h.summary,
      customer: await getProfileByConversation(conv.id),
      messages: await getHistory(conv.id, 200, false),
    };
  });

  // Take a waiting conversation (or re-open one already assigned to you). Returns a LiveKit token for its room.
  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/accept", async (req) => {
    const { username } = await requireAgent(req);
    const conv = await findConversation(req.params.id);
    if (conv.status === "assigned" && conv.assigned_agent === username) return joinInfo(conv.id, username);
    if (conv.status !== "waiting") throw httpError(403, "Conversation is not available to you");

    const r = await assignToAgent(conv.id, username);
    if (r === "full") throw httpError(409, "At your concurrent conversation limit");
    if (r === "unavailable") {
      // lost a race: it may have been assigned to this very agent a moment ago (e.g. by the escalation itself)
      const h = await getHandoff(conv.id);
      if (h.status === "assigned" && h.agent_id === username) return joinInfo(conv.id, username);
      throw httpError(409, "Conversation was just taken by someone else");
    }
    return joinInfo(conv.id, username);
  });

  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/resolve", async (req) => {
    const { username } = await requireAgent(req);
    const conv = await findConversation(req.params.id);
    if (conv.status !== "assigned" || conv.assigned_agent !== username) throw httpError(403, "Not assigned to you");
    const { returnToAi } = (req.body ?? {}) as { returnToAi?: boolean };
    await resolveConversation(conv.id, username, returnToAi !== false);
    return { status: returnToAi !== false ? "ai" : "closed" };
  });
}
