import nodemailer from "nodemailer";
import type { ToolDefinition } from "../../core/types.js";

// A real connector tool, inspired by n8n/OpenHands' third-party
// integrations — real SMTP email sending via nodemailer (the standard,
// well-maintained Node email library; not hand-rolled, unlike this
// project's protocol-testing tools under security/ — SMTP here is used
// for real functionality, not as a reachability/auth check, so a mature
// library is the right call the same way mysql2/pg already are for the
// database tools).
//
// Credentials come from env vars (SMTP_HOST/SMTP_PORT/SMTP_USER/
// SMTP_PASS/SMTP_FROM), never from tool input — the model should never
// see or need to handle real SMTP credentials directly.
export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig | undefined {
  const host = env.SMTP_HOST;
  const from = env.SMTP_FROM ?? env.SMTP_USER;
  if (!host || !from) return undefined;
  return {
    host,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from,
  };
}

interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
}

export function createSendEmailTool(config: EmailConfig | undefined): ToolDefinition<SendEmailInput> {
  return {
    name: "send_email",
    description:
      "Send a real email via SMTP. Requires SMTP_HOST/SMTP_FROM (and usually SMTP_USER/SMTP_PASS/SMTP_PORT/" +
      "SMTP_SECURE) to be configured as environment variables — this tool never takes credentials as input. " +
      "IMPORTANT: this sends a real, irreversible email to a real recipient — confirm the recipient/subject/" +
      "body with the user before calling this unless they've explicitly asked for this exact email.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body text (or HTML if html:true)" },
        html: { type: "boolean", description: "Whether `body` is HTML (default false — plain text)" },
      },
      required: ["to", "subject", "body"],
    },
    describeCall: (input) => `send email to ${input.to}: "${input.subject}"`,
    async handler(input) {
      if (!config) {
        return {
          content: "SMTP is not configured — set SMTP_HOST and SMTP_FROM (and usually SMTP_USER/SMTP_PASS) as environment variables to enable send_email.",
          isError: true,
        };
      }
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      });
      try {
        const info = await transporter.sendMail({
          from: config.from,
          to: input.to,
          subject: input.subject,
          text: input.html ? undefined : input.body,
          html: input.html ? input.body : undefined,
        });
        return { content: `Email sent to ${input.to} (message id: ${info.messageId}).`, isError: false };
      } catch (err) {
        return { content: `Failed to send email: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      } finally {
        transporter.close();
      }
    },
  };
}
