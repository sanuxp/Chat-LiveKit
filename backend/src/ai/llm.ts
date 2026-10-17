import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

/** OpenAI-compatible client (works with a LiteLLM proxy, Azure via LiteLLM, or OpenAI itself). */
function baseUrl(): string {
  const raw = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
  if (!raw) throw new Error("LLM_BASE_URL is not set");
  return /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
}

let client: OpenAI | undefined;
const getClient = () =>
  (client ??= new OpenAI({ baseURL: baseUrl(), apiKey: process.env.LLM_API_KEY ?? "" }));

export const llmModel = () => process.env.LLM_MODEL || "gpt-4.1-mini";

export interface LlmToolCall { id: string; name: string; arguments: string }
export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "done"; toolCalls: LlmToolCall[]; usage?: { prompt: number; completion: number } };

export async function* streamCompletion(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
): AsyncGenerator<LlmEvent> {
  const stream = await getClient().chat.completions.create({
    model: llmModel(),
    messages,
    tools: tools.length ? tools : undefined,
    stream: true,
    stream_options: { include_usage: true },
  });
  const calls = new Map<number, LlmToolCall>();
  let usage: { prompt: number; completion: number } | undefined;
  for await (const chunk of stream) {
    if (chunk.usage) usage = { prompt: chunk.usage.prompt_tokens, completion: chunk.usage.completion_tokens };
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) yield { type: "text", text: delta.content };
    for (const tc of delta.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  yield { type: "done", toolCalls: [...calls.values()], usage };
}
