// Tiny OpenAI-compatible streaming server for local testing without a real LLM.
//   node scripts/mock-llm.mjs            (listens on :4000)
//   .env: LLM_BASE_URL=http://host.docker.internal:4000
// - a message mentioning "human" / "agent" / "person" -> tool call escalate_to_human_chat
// - anything else -> "You said: <text>" streamed in a few chunks
// - also serves /v1/audio/transcriptions and /v1/audio/speech (see below)
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4000);
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta, finish = null) => ({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });

// Voice: the OpenAI-compatible audio endpoints, so the voice worker's default STT/TTS work offline.
//   POST /v1/audio/transcriptions -> always hears MOCK_STT_TEXT
//   POST /v1/audio/speech         -> 1.5 s 440 Hz tone as raw 24 kHz PCM (run the worker with OPENAI_TTS_RESPONSE_FORMAT=pcm)
const STT_TEXT = process.env.MOCK_STT_TEXT ?? "What are your support hours?";
function tonePcm(seconds = 1.5, rate = 24000) {
  const buf = Buffer.alloc(Math.floor(seconds * rate) * 2);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
  return buf;
}

createServer((req, res) => {
  if (req.method === "POST" && req.url.endsWith("/audio/transcriptions")) {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: STT_TEXT })); });
    return;
  }
  if (req.method === "POST" && req.url.endsWith("/audio/speech")) {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const pcm = tonePcm();
      let wantsSse = false;
      try { wantsSse = JSON.parse(raw).stream_format === "sse"; } catch { /* not JSON */ }
      if (!wantsSse) { res.writeHead(200, { "Content-Type": "audio/pcm" }).end(pcm); return; } // tts-1 style: raw audio bytes
      // gpt-4o-mini-tts style: server-sent events with base64 audio
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (let i = 0; i < pcm.length; i += 8192) res.write(`data: ${JSON.stringify({ type: "speech.audio.delta", audio: pcm.subarray(i, i + 8192).toString("base64") })}

`);
      res.write(`data: ${JSON.stringify({ type: "speech.audio.done", usage: { input_tokens: 1, output_tokens: 1 } })}

`);
      res.end();
    });
    return;
  }
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
