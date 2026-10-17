import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildSystemPrompt, readPromptFile } from "../ai/prompt.js";
import { config } from "../config.js";
import { addMessage, getHandoff, getHistory } from "../conversations.js";
import { getProfileByConversation } from "../customer/profile.js";
import { pool } from "../db/db.js";
import { customerIdentity, dispatchVoiceAgent } from "../realtime/livekit.js";
import { executeTool, getTools } from "../tools/registry.js";
import { describeCatalog, getSelection, saveSelection, validateSelection } from "../voice/catalog.js";
import { httpError, requireAgent, verifyToken } from "./auth.js";

function requireInternal(req: FastifyRequest): void {
  if (!config.internalApiToken) throw httpError(503, "INTERNAL_API_TOKEN is not configured");
  const h = req.headers.authorization ?? "";
  const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(config.internalApiToken);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw httpError(401, "Invalid internal token");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // ---- admin: choose the voice pipeline (Agent console -> Voice settings) -----------------------
  app.get("/api/voice/settings", async (req) => {
    await requireAgent(req);
    const { catalog, selection } = await getSelection();
    return { catalog: describeCatalog(catalog), selection, issues: validateSelection(catalog, selection), voiceEnabledInEnv: config.enableVoice };
  });

  app.put("/api/voice/settings", async (req, reply) => {
    await requireAgent(req);
    const r = await saveSelection(req.body);
    // errors (invalid combinations) are reported as 422 and nothing is stored
    return reply.code(r.saved ? 200 : 422).send(r);
  });

  // ---- customer: start the AI voice assistant in this conversation's room ------------------------
  app.post<{ Params: { id: string } }>("/api/conversations/:id/voice/start", async (req) => {
    const claims = verifyToken(req);
    if (claims.role !== "customer" || claims.conv !== req.params.id) throw httpError(404, "Conversation not found");
    if (!config.enableVoice) throw httpError(409, "Voice is not enabled");
    const { selection } = await getSelection();
    if (!selection.enabled) throw httpError(409, "The voice assistant is switched off");
    const h = await getHandoff(req.params.id).catch(() => null);
    if (!h) throw httpError(404, "Conversation not found");
    if (h.status !== "ai") throw httpError(409, "The voice assistant is only available while the AI is handling the conversation");
    return { voice: await dispatchVoiceAgent(req.params.id) };
  });

  // ---- internal: used by the voice worker (shared secret) -----------------------------------------
  // Everything the worker needs to run one call: chosen pipeline, system prompt, history, tool schemas.
  app.get<{ Params: { id: string } }>("/api/internal/voice/session/:id", async (req) => {
    requireInternal(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw httpError(400, "Bad conversation id");
    const row = (await pool.query("SELECT customer_id FROM conversations WHERE id=$1 AND deleted_at IS NULL", [id])).rows[0];
    if (!row) throw httpError(404, "Conversation not found");
    const [{ selection }, handoff, profile, history] = await Promise.all([
      getSelection(), getHandoff(id), getProfileByConversation(id), getHistory(id, Number(process.env.AI_HISTORY_MESSAGES ?? 30), false),
    ]);
    const tools = getTools();
    const [base, voice] = await Promise.all([buildSystemPrompt(tools.promptTools, profile), readPromptFile("voice.md").catch(() => "")]);
    return {
      conversationId: id,
      customerIdentity: customerIdentity(row.customer_id),
      status: handoff.status,
      selection,
      systemPrompt: voice ? `${base}\n\n${voice.trim()}` : base,
      history: history
        .filter((m) => m.kind !== "notice")
        .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", text: m.role === "agent" ? `[Human agent] ${m.body}` : m.body })),
      tools: tools.llmTools.map((t) => (t.type === "function" ? { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } } : null)).filter(Boolean),
    };
  });

  // Transcript lines from the call, stored like normal chat messages (no AI reply is triggered).
  app.post<{ Params: { id: string } }>("/api/internal/conversations/:id/messages", async (req) => {
    requireInternal(req);
    const { role, body } = (req.body ?? {}) as { role?: string; body?: string };
    if ((role !== "customer" && role !== "ai") || typeof body !== "string" || !body.trim()) throw httpError(400, "role (customer|ai) and body required");
    const msg = await addMessage(req.params.id, { role, body: body.trim().slice(0, 4000) });
    return { id: msg.id };
  });

  app.post<{ Params: { id: string; name: string } }>("/api/internal/conversations/:id/tools/:name", async (req) => {
    requireInternal(req);
    const args = JSON.stringify(((req.body ?? {}) as { arguments?: unknown }).arguments ?? {});
    return executeTool(req.params.name, args, req.params.id);
  });
}
