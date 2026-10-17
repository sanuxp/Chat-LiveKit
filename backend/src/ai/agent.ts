import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getHandoff, getHistory, sendNotice } from "../conversations.js";
import { getProfileByConversation } from "../customer/profile.js";
import { publish } from "../realtime/livekit.js";
import { updateHandoff } from "../routing/handoff.js";
import { executeTool, getTools, toolAfter } from "../tools/registry.js";
import { streamCompletion } from "./llm.js";
import { buildSystemPrompt } from "./prompt.js";
import { StreamingMessage } from "./streaming.js";

// NOTE (logging rule): never log message bodies, prompts/responses or tool arguments.
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const HISTORY = () => Number(process.env.AI_HISTORY_MESSAGES ?? 30);
const STREAM_MS = () => Number(process.env.AI_STREAM_INTERVAL_MS ?? 60);

// one reply at a time per conversation, so quick successive messages don't interleave
const queues = new Map<string, Promise<void>>();

/** Called by the REST layer after a customer message has been stored. */
export function enqueueAiReply(conversationId: string, messageId: string): void {
  const prev = queues.get(conversationId) ?? Promise.resolve();
  const next = prev.then(() => handleCustomerMessage(conversationId, messageId)).catch(() => {});
  queues.set(conversationId, next);
  void next.finally(() => { if (queues.get(conversationId) === next) queues.delete(conversationId); });
}

function aiMayReply(h: { status: string; channel: string | null }): boolean {
  if (h.status === "ai") return true;
  // after an external escalation (e.g. email) the AI keeps talking only if that tool says continue_ai
  return h.status === "escalated_external" && toolAfter(h.channel) === "continue_ai";
}

async function handleCustomerMessage(conversationId: string, messageId: string): Promise<void> {
  const started = Date.now();
  let typingTimer: NodeJS.Timeout | undefined;
  try {
    let handoff;
    try { handoff = await getHandoff(conversationId); } catch { return; } // deleted meanwhile
    if (!aiMayReply(handoff)) return;

    void publish(conversationId, { t: "typing", on: true });
    typingTimer = setInterval(() => void publish(conversationId, { t: "typing", on: true }), 15000);
    const tools = getTools();
    const [history, profile] = await Promise.all([
      getHistory(conversationId, HISTORY(), false),
      getProfileByConversation(conversationId),
    ]);
    const systemPrompt = await buildSystemPrompt(tools.promptTools, profile);
    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
    if (handoff.ai_note) messages.push({ role: "system", content: handoff.ai_note });
    for (const m of history) {
      if (m.kind === "notice") continue; // system notices are not part of the conversation
      if (m.role === "ai") messages.push({ role: "assistant", content: m.body });
      else if (m.role === "customer") messages.push({ role: "user", content: m.body });
      else messages.push({ role: "user", content: `[Human agent] ${m.body}` });
    }

    let promptTokens = 0, completionTokens = 0, rounds = 0;
    for (let round = 0; ; round++) {
      const allowTools = round < tools.maxToolRounds && tools.llmTools.length > 0;
      const out = new StreamingMessage(conversationId, STREAM_MS());
      let toolCalls: { id: string; name: string; arguments: string }[] = [];
      for await (const ev of streamCompletion(messages, allowTools ? tools.llmTools : [])) {
        if (ev.type === "text") out.append(ev.text);
        else {
          toolCalls = ev.toolCalls;
          promptTokens += ev.usage?.prompt ?? 0;
          completionTokens += ev.usage?.completion ?? 0;
        }
      }
      const text = await out.finish();
      rounds++;
      if (!toolCalls.length) break;

      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      let endTurn = false;
      for (const c of toolCalls) {
        const t0 = Date.now();
        const res = await executeTool(c.name, c.arguments, conversationId);
        log("tool executed", { conversationId, tool: c.name, ok: res.ok, ms: Date.now() - t0 });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(res.llmResult) });
        if (res.endTurn) endTurn = true;
      }
      if (endTurn) break;
    }
    if (handoff.ai_note) await updateHandoff(conversationId, { ai_note: null }).catch(() => {});
    log("ai replied", { conversationId, messageId, rounds, promptTokens, completionTokens, ms: Date.now() - started });
  } catch (err: any) {
    log("ai error", { conversationId, messageId, name: err?.name, status: err?.status, code: err?.code });
    await sendNotice(conversationId, "Sorry, something went wrong, please try again.").catch(() => {});
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    await publish(conversationId, { t: "typing", on: false });
  }
}

