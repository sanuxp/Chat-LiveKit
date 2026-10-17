import { watch } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PromptTool } from "../ai/prompt.js";
import { addMessage, getCustomerRef, getHandoff, getTranscript, sendNotice } from "../conversations.js";
import { getProfileByConversation, profileVars } from "../customer/profile.js";
import { updateHandoff } from "../routing/handoff.js";
import emailHandler from "./handlers/email.js";
import humanChatHandler from "./handlers/humanChat.js";
import webhookHandler from "./handlers/webhook.js";
import { renderTemplate, resolveEnv } from "./template.js";
import type { After, Logger, ToolContext, ToolHandler } from "./types.js";

// ---------------------------------------------------------------------------------------------
// tools.yaml schema
// ---------------------------------------------------------------------------------------------

const ToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "must match ^[a-zA-Z0-9_-]{1,64}$"),
  enabled: z.boolean().default(true),
  handler: z.enum(["human_chat", "email", "webhook", "custom"]),
  module: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  description: z.string().min(1),
  prompt_file: z.string().optional(),
  parameters: z.record(z.any()).default({ type: "object", properties: {} }),
  after: z.enum(["pause_ai", "continue_ai", "close"]).default("continue_ai"),
  customer_message: z.string().optional(),
  options: z.record(z.any()).default({}),
}).strict();

const FileSchema = z.object({
  max_tool_rounds: z.number().int().min(1).max(10).default(3),
  tools: z.array(ToolSchema).default([]),
}).strict();

type ToolDef = z.infer<typeof ToolSchema>;

export class ToolConfigError extends Error {}

interface LoadedTool {
  def: ToolDef;
  options: Record<string, unknown>; // env-resolved
  handler: ToolHandler;
  validate: ValidateFunction;
}
interface RegistryState { maxRounds: number; tools: Map<string, LoadedTool> }

// ajv-formats is CommonJS; under NodeNext the callable lives on .default
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (a: Ajv) => void;

let state: RegistryState = { maxRounds: 3, tools: new Map() };

const toolsPath = () => resolve(process.env.TOOLS_CONFIG_PATH ?? "./config/tools.yaml");
const promptsDir = () => resolve(process.env.PROMPTS_DIR ?? "./config/prompts");

const log: Logger = {
  info: (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })),
  error: (msg, extra = {}) => console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg, ...extra })),
};

// ---------------------------------------------------------------------------------------------
// loading + validation
// ---------------------------------------------------------------------------------------------

const exists = (p: string) => access(p).then(() => true, () => false);

async function build(): Promise<RegistryState> {
  const file = toolsPath();
  if (!(await exists(file))) throw new ToolConfigError(`tools config not found: ${file}`);
  let raw: unknown;
  try { raw = parseYaml(await readFile(file, "utf8")); }
  catch (e: any) { throw new ToolConfigError(`${file}: invalid YAML: ${e.message}`); }

  const parsed = FileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const rawTools = ((raw as any)?.tools ?? []) as any[];
    const lines = parsed.error.issues.map((i) => {
      const [first, idx, ...rest] = i.path;
      if (first === "tools" && typeof idx === "number") {
        const nm = rawTools[idx]?.name ? ` "${rawTools[idx].name}"` : "";
        return `tools[${idx}]${nm}${rest.length ? "." + rest.join(".") : ""}: ${i.message}`;
      }
      return `${i.path.join(".") || "(root)"}: ${i.message}`;
    });
    throw new ToolConfigError(`Invalid tools config ${file}:\n  - ${lines.join("\n  - ")}`);
  }

  const cfg = parsed.data;
  const names = new Set<string>();
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const tools = new Map<string, LoadedTool>();

  for (const [i, def] of cfg.tools.entries()) {
    const where = `tools[${i}] "${def.name}"`;
    if (names.has(def.name)) throw new ToolConfigError(`${where}: duplicate tool name`);
    names.add(def.name);
    if (def.handler === "custom" && !def.module) throw new ToolConfigError(`${where}: handler "custom" requires "module"`);
    if (def.prompt_file && !(await exists(resolve(promptsDir(), def.prompt_file.replace(/^prompts\//, ""))))) {
      throw new ToolConfigError(`${where}: prompt_file "${def.prompt_file}" not found in ${promptsDir()}`);
    }
    let validate: ValidateFunction;
    try { validate = ajv.compile(def.parameters); }
    catch (e: any) { throw new ToolConfigError(`${where}: invalid "parameters" JSON Schema: ${e.message}`); }
    if (!def.enabled) continue; // disabled tools are validated structurally but never resolved/loaded

    let options: Record<string, unknown>;
    try { options = resolveEnv(def.options, `${where}.options`); }
    catch (e: any) { throw new ToolConfigError(e.message); }

    let handler: ToolHandler;
    if (def.handler === "human_chat") handler = humanChatHandler;
    else if (def.handler === "email") handler = emailHandler;
    else if (def.handler === "webhook") handler = webhookHandler;
    else {
      try { handler = (await import(`./custom/${def.module}.js`)).default as ToolHandler; }
      catch (e: any) { throw new ToolConfigError(`${where}: cannot load custom module "${def.module}": ${e.message}`); }
      if (typeof handler?.execute !== "function") throw new ToolConfigError(`${where}: custom module "${def.module}" must default-export a ToolHandler`);
    }
    tools.set(def.name, { def, options, handler, validate });
  }

  for (const [name, t] of tools) {
    const fb = t.options.fallback_tool;
    if (typeof fb === "string" && !names.has(fb)) {
      throw new ToolConfigError(`tool "${name}": options.fallback_tool "${fb}" is not defined in tools.yaml`);
    }
  }
  return { maxRounds: cfg.max_tool_rounds, tools };
}

/** Load (or reload) tools.yaml. On failure the previous registry stays active and the error is thrown. */
export async function loadTools(): Promise<void> {
  state = await build();
  log.info("tools loaded", { enabled: [...state.tools.keys()] });
}

/** Dev convenience: reload on file change. Errors are logged and the old config is kept. */
export function watchConfig(): void {
  if (process.env.NODE_ENV === "production") return;
  let t: NodeJS.Timeout | undefined;
  const onChange = () => {
    clearTimeout(t);
    t = setTimeout(() => loadTools().catch((e) => log.error("config reload failed", { error: e.message })), 300);
  };
  for (const dir of [dirname(toolsPath()), promptsDir()]) {
    try { watch(dir, { recursive: true }, onChange); } catch { /* unsupported platform */ }
  }
}

// ---------------------------------------------------------------------------------------------
// what the AI sees
// ---------------------------------------------------------------------------------------------

export interface RegisteredTools {
  maxToolRounds: number;
  promptTools: PromptTool[];
  llmTools: ChatCompletionTool[];
}

export function getTools(): RegisteredTools {
  const enabled = [...state.tools.values()];
  return {
    maxToolRounds: state.maxRounds,
    promptTools: enabled.map((t) => ({ name: t.def.name, description: t.def.description, promptFile: t.def.prompt_file })),
    llmTools: enabled.map((t) => ({
      type: "function",
      function: { name: t.def.name, description: t.def.description.trim(), parameters: t.def.parameters },
    })),
  };
}

/** Used by the agent to decide whether the AI may keep talking after an external escalation. */
export function toolAfter(name: string | null): After | undefined {
  return name ? state.tools.get(name)?.def.after : undefined;
}

export function toolOptions(name: string | null): Record<string, unknown> | undefined {
  return name ? state.tools.get(name)?.options : undefined;
}

// ---------------------------------------------------------------------------------------------
// execution (core applies `customer_message` and `after`, handlers don't)
// ---------------------------------------------------------------------------------------------

export async function executeTool(
  name: string, argsJson: string, conversationId: string,
): Promise<{ ok: boolean; llmResult: unknown; endTurn?: boolean; customerText?: string }> {
  const tool = state.tools.get(name);
  if (!tool) return { ok: false, llmResult: { error: "Unknown tool" } };

  let args: Record<string, unknown>;
  try { args = argsJson ? JSON.parse(argsJson) : {}; }
  catch { return { ok: false, llmResult: { error: "Arguments were not valid JSON" } }; }
  if (!tool.validate(args)) {
    // only property paths/keywords are reported back, never argument values
    const problems = (tool.validate.errors ?? []).map((e) => `${e.instancePath || "(args)"} ${e.message}`);
    return { ok: false, llmResult: { error: "Invalid arguments", problems } };
  }

  const [customerRef, customer] = await Promise.all([getCustomerRef(conversationId), getProfileByConversation(conversationId)]);
  const ctx: ToolContext = {
    conversationId, customerRef, customer, toolName: name,
    chat: {
      sendNotice: async (text) => { await sendNotice(conversationId, text); },
      getTranscript: (limit) => getTranscript(conversationId, limit),
    },
    handoff: {
      get: () => getHandoff(conversationId),
      set: async (u) => { await updateHandoff(conversationId, u); },
    },
    options: tool.options,
    log: {
      info: (m, e = {}) => log.info(m, { conversationId, tool: name, ...e }),
      error: (m, e = {}) => log.error(m, { conversationId, tool: name, ...e }),
    },
  };

  let res;
  try { res = await tool.handler.execute(args, ctx); }
  catch (e: any) {
    log.error("tool handler threw", { conversationId, tool: name, error: e?.name });
    return { ok: false, llmResult: { error: "The tool failed unexpectedly" } };
  }
  if (!res.ok) return { ok: false, llmResult: res.llmResult };

  const tpl = res.customerMessage ?? tool.def.customer_message;
  let customerText: string | undefined;
  if (tpl) {
    customerText = renderTemplate(tpl, { ...profileVars(customer), ...args, conversation_id: conversationId, customer_ref: customerRef });
    if (customerText) await addMessage(conversationId, { role: "ai", body: customerText });
  }
  await applyAfter(conversationId, name, tool.def.after);
  // pause_ai / close: the AI must not add more text this turn (it would duplicate customer_message)
  return { ok: true, llmResult: res.llmResult, endTurn: tool.def.after !== "continue_ai", customerText };
}

async function applyAfter(conversationId: string, name: string, after: After): Promise<void> {
  if (after === "continue_ai") return;
  const h = await getHandoff(conversationId);
  if (after === "close") {
    await updateHandoff(conversationId, { status: "closed", channel: name });
  } else if (after === "pause_ai" && h.status === "ai") {
    // handlers like human_chat already moved the status; for others pause the AI via escalated_external
    await updateHandoff(conversationId, { status: "escalated_external", channel: name });
  }
}
