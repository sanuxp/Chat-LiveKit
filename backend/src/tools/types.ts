import type { Profile } from "../customer/profile.js";
import type { HandoffState } from "../conversations.js";

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface ToolContext {
  conversationId: string;
  customerRef: string;
  customer: Profile; // name/email/phone/metadata from the host page (defaults applied). Personal data: never log.
  toolName: string;
  chat: {
    sendNotice(text: string): Promise<void>;
    getTranscript(limit?: number): Promise<string>;
  };
  handoff: {
    set(update: Partial<HandoffState>): Promise<void>;
    get(): Promise<HandoffState>;
  };
  options: Record<string, unknown>; // tool's options from yaml, env-resolved
  log: Logger; // must not log customer content
}

export interface ToolResult {
  ok: boolean;
  llmResult: unknown; // returned to the LLM as the tool message content
  customerMessage?: string; // overrides yaml customer_message if set ("" = post nothing)
}

export interface ToolHandler {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type After = "pause_ai" | "continue_ai" | "close";
