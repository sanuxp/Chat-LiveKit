import nodemailer from "nodemailer";
import { readPromptFile } from "../../ai/prompt.js";
import { profileVars } from "../../customer/profile.js";
import { renderTemplate } from "../template.js";
import type { ToolHandler } from "../types.js";

/** SMTP transport from env, so Mailpit (local), Gmail, SES, ... are just different .env values. */
function transport() {
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465, // 465 = implicit TLS; 587 = STARTTLS
    requireTLS: !!user, // never send credentials in clear text
    auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

const email: ToolHandler = {
  async execute(args, ctx) {
    const o = ctx.options as {
      to?: string[]; subject_template?: string; body_template_file?: string; include_transcript?: boolean;
    };
    if (!process.env.SMTP_HOST) return { ok: false, llmResult: { sent: false, error: "Email is not configured" } };
    if (!o.to?.length) return { ok: false, llmResult: { sent: false, error: "No email recipient is configured" } };

    const transcript = o.include_transcript ? await ctx.chat.getTranscript(200) : "";
    // profile variables first, so an explicit tool argument (e.g. customer_email the customer confirmed) wins
    const vars = { ...profileVars(ctx.customer), ...args, conversation_id: ctx.conversationId, customer_ref: ctx.customerRef, transcript };
    const subject = oneLine(renderTemplate(o.subject_template ?? "[Chat escalation] {{reason}}", vars));
    const body = renderTemplate(
      o.body_template_file
        ? await readPromptFile(o.body_template_file)
        : "Reason: {{reason}}\nCustomer: {{customer_email}}\n\n{{summary}}\n\n{{transcript}}",
      vars,
    );

    try {
      await transport().sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: o.to,
        replyTo: typeof args.customer_email === "string" ? args.customer_email : undefined,
        subject,
        text: body,
      });
    } catch (e: any) {
      // log the failure class only: error text can echo addresses or message content
      ctx.log.error("email send failed", { code: e?.code, responseCode: e?.responseCode });
      return { ok: false, llmResult: { sent: false, error: "The email could not be sent right now" } };
    }

    await ctx.handoff.set({
      status: "escalated_external",
      channel: ctx.toolName,
      reason: String(args.reason ?? ""),
      summary: String(args.summary ?? ""),
    });
    ctx.log.info("email sent", { recipients: o.to.length });
    return { ok: true, llmResult: { sent: true } };
  },
};

export default email;
