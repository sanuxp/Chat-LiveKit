import { createHmac } from "node:crypto";
import type { ToolHandler } from "../types.js";

const MAX_RESPONSE_BYTES = 4096;

/** POST tool arguments + context as signed JSON to any HTTP endpoint. */
const webhook: ToolHandler = {
  async execute(args, ctx) {
    const o = ctx.options as {
      url?: string; method?: string; headers?: Record<string, string>; timeout_ms?: number;
      include_transcript?: boolean; return_response_to_llm?: boolean;
    };
    const secret = process.env.WEBHOOK_SIGNING_SECRET;
    if (!o.url) return { ok: false, llmResult: { error: "Webhook URL is not configured" } };
    if (!secret) return { ok: false, llmResult: { error: "Webhook signing is not configured" } };

    const payload: Record<string, unknown> = {
      tool: ctx.toolName, args, conversation_id: ctx.conversationId, customer_ref: ctx.customerRef,
      customer: ctx.customer, // { name, email, phone, metadata } from the host page (defaults applied)
    };
    if (o.include_transcript) payload.transcript = await ctx.chat.getTranscript(200);
    const body = JSON.stringify(payload);
    const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeout_ms ?? 10_000);
    try {
      const res = await fetch(o.url, {
        method: o.method ?? "POST",
        headers: { "Content-Type": "application/json", ...(o.headers ?? {}), "X-SupportChat-Signature": signature },
        body,
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        ctx.log.error("webhook non-2xx", { status: res.status });
        return { ok: false, llmResult: { error: `The service responded with status ${res.status}` } };
      }
      ctx.log.info("webhook ok", { status: res.status });
      if (!o.return_response_to_llm) return { ok: true, llmResult: { ok: true } };
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        return { ok: true, llmResult: { truncated: true, body: text.slice(0, MAX_RESPONSE_BYTES) } };
      }
      try { return { ok: true, llmResult: JSON.parse(text) }; }
      catch { return { ok: true, llmResult: { body: text } }; }
    } catch (e: any) {
      ctx.log.error("webhook failed", { reason: e?.name === "AbortError" ? "timeout" : e?.code ?? e?.name });
      return { ok: false, llmResult: { error: e?.name === "AbortError" ? "The service timed out" : "The service could not be reached" } };
    } finally {
      clearTimeout(timer);
    }
  },
};

export default webhook;
