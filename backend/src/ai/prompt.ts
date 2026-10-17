import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { profileVars, type Profile } from "../customer/profile.js";

const promptsDir = () => resolve(process.env.PROMPTS_DIR ?? "./config/prompts");

export async function readPromptFile(relPath: string): Promise<string> {
  // tools.yaml uses paths like "prompts/escalate_email.md"; accept both that and bare names
  const name = relPath.replace(/^prompts\//, "");
  return readFile(resolve(promptsDir(), name), "utf8");
}

export interface PromptTool { name: string; description: string; promptFile?: string }

export async function buildSystemPrompt(tools: PromptTool[], profile?: Profile): Promise<string> {
  // read the main prompt and every tool snippet concurrently
  const [main, ...snippets] = await Promise.all([
    readPromptFile("system.md"),
    ...tools.map((t) => (t.promptFile ? readPromptFile(t.promptFile) : Promise.resolve(""))),
  ]);
  let text = main;
  const list = tools.length ? tools.map((t) => `- ${t.name}: ${t.description.trim()}`).join("\n") : "(none)";
  text = text
    .replaceAll("{{company_name}}", process.env.COMPANY_NAME || "our company")
    .replaceAll("{{now}}", new Date().toISOString())
    .replaceAll("{{available_tools}}", list);
  // {{customer_name}} {{customer_email}} {{customer_phone}} {{customer_meta}} (supplied by the host web page)
  if (profile) for (const [k, v] of Object.entries(profileVars(profile))) text = text.replaceAll(`{{${k}}}`, v);
  tools.forEach((t, i) => {
    if (t.promptFile) text += `\n\n## Tool: ${t.name}\n${snippets[i].trim()}`;
  });
  return text;
}
