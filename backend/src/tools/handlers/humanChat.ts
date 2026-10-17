import { armFallback } from "../../routing/handoff.js";
import type { ToolHandler } from "../types.js";

/** Put the conversation in the waiting queue; an agent takes it by accepting it in the console. A fallback timer returns it to the AI if nobody does. */
const humanChat: ToolHandler = {
  async execute(args, ctx) {
    const current = await ctx.handoff.get();
    if (current.status === "waiting" || current.status === "assigned") {
      // already escalated: don't repeat the customer message
      return { ok: true, llmResult: { status: current.status, note: "already escalated" }, customerMessage: "" };
    }

    await ctx.handoff.set({
      status: "waiting",
      channel: ctx.toolName,
      reason: String(args.reason ?? ""),
      summary: String(args.summary ?? ""),
      ai_note: null,
    });

    const fallbackTool = typeof ctx.options.fallback_tool === "string" ? ctx.options.fallback_tool : undefined;
    const seconds = Number(ctx.options.fallback_after_seconds ?? 300);
    armFallback(ctx.conversationId, seconds, fallbackTool);
    ctx.log.info("conversation queued", { fallbackAfterSeconds: seconds });
    return { ok: true, llmResult: { status: "waiting", note: "The customer is in the queue until a human agent accepts." } };
  },
};

export default humanChat;
