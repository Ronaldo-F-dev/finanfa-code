import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import type { AddressInfo } from "node:net";
import { createSendEmailTool, emailConfigFromEnv, type EmailConfig } from "../../src/tools/builtin/send-email.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_email tool (real local SMTP server, real nodemailer)", () => {
  let server: SMTPServer;
  let config: EmailConfig;
  let received: ParsedMail | undefined;
  let rejectNext = false;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      // This fixture models a plain local SMTP relay (no encryption) —
      // hideSTARTTLS keeps the test transporter from opportunistically
      // negotiating TLS against the server's default, publicly-known
      // self-signed cert (which nodemailer correctly refuses to trust,
      // exactly as it should against a real, unknown-cert server).
      hideSTARTTLS: true,
      onData(stream, _session, callback) {
        if (rejectNext) {
          stream.resume();
          callback(new Error("mailbox unavailable"));
          return;
        }
        simpleParser(stream, {}, (err, parsed) => {
          received = err ? undefined : parsed;
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.server.address() as AddressInfo).port;
    config = { host: "127.0.0.1", port, secure: false, from: "bot@example.com" };
  });

  afterAll(() => {
    server.close();
  });

  it("sends a real plain-text email through a real local SMTP server", async () => {
    const tool = createSendEmailTool(config);
    const result = await tool.handler({ to: "user@example.com", subject: "Real test", body: "Hello from the real test." }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Email sent to user@example.com");

    await new Promise((r) => setTimeout(r, 100));
    expect(received?.subject).toBe("Real test");
    expect(received?.text?.trim()).toBe("Hello from the real test.");
  });

  it("sends real HTML content when html:true", async () => {
    const tool = createSendEmailTool(config);
    await tool.handler({ to: "user@example.com", subject: "HTML test", body: "<p>Hi</p>", html: true }, ctx);
    await new Promise((r) => setTimeout(r, 100));
    expect(received?.html).toContain("<p>Hi</p>");
  });

  it("reports a real SMTP-level rejection as a tool error, not a thrown exception", async () => {
    rejectNext = true;
    const tool = createSendEmailTool(config);
    const result = await tool.handler({ to: "user@example.com", subject: "will fail", body: "x" }, ctx);
    expect(result.isError).toBe(true);
    rejectNext = false;
  });

  it("reports a clear error when SMTP is not configured, instead of throwing", async () => {
    const tool = createSendEmailTool(undefined);
    const result = await tool.handler({ to: "user@example.com", subject: "x", body: "y" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SMTP is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendEmailTool(config).riskLevel).toBe("ask");
  });
});

describe("emailConfigFromEnv", () => {
  it("returns undefined when SMTP_HOST/SMTP_FROM are not set", () => {
    expect(emailConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from real env-var-shaped input", () => {
    const config = emailConfigFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "bot@example.com", SMTP_PORT: "465", SMTP_SECURE: "true" } as NodeJS.ProcessEnv);
    expect(config).toEqual({ host: "smtp.example.com", port: 465, secure: true, user: undefined, pass: undefined, from: "bot@example.com" });
  });

  it("falls back to SMTP_USER as the from address when SMTP_FROM is unset", () => {
    const config = emailConfigFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "user@example.com" } as NodeJS.ProcessEnv);
    expect(config?.from).toBe("user@example.com");
  });
});
