// Tiny OpenAI-compatible streaming server for local testing without a real LLM.
//   node scripts/mock-llm.mjs            (listens on :4000)
//   .env: LLM_BASE_URL=http://host.docker.internal:4000
// - a message mentioning "human" / "agent" / "person" -> tool call escalate_to_human_chat
// - anything else -> "You said: <text>" streamed in a few chunks
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4000);
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta, finish = null) => ({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });

createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    const body = JSON.parse(raw);
    const msgs = body.messages ?? [];
    const last = msgs[msgs.length - 1] ?? {};
    const text = String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "");
    const canEscalate = (body.tools ?? []).some((t) => t.function?.name === "escalate_to_human_chat");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    if (last.role !== "tool" && canEscalate && /human|agent|person/i.test(text)) {
      sse(res, chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "escalate_to_human_chat", arguments: JSON.stringify({ reason: "Customer asked for a human", summary: `Customer said: ${text}` }) } }] }));
      sse(res, chunk({}, "tool_calls"));
    } else {
      for (const part of `You said: ${text}`.match(/.{1,12}/g) ?? []) {
        sse(res, chunk({ content: part }));
        await new Promise((r) => setTimeout(r, 120));
      }
      sse(res, chunk({}, "stop"));
    }
    sse(res, { id: "mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, () => console.log(`mock LLM on :${PORT}`));
