import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendWhatsappMessageTool, whatsappConfigFromEnv, postWhatsappMessage } from "../../src/tools/builtin/send-whatsapp-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_whatsapp_message tool (real local HTTP server speaking WhatsApp Cloud API's shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { url: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { url: req.url ?? "", headers: req.headers, body };
        res.writeHead(shouldError ? 400 : 200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ error: { message: "Recipient phone number not in allowed list", code: 131030 } }));
        } else {
          res.end(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "15551234567", wa_id: "15551234567" }], messages: [{ id: "wamid.HBg" }] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real authenticated request to the right phone number and reports success", async () => {
    const tool = createSendWhatsappMessageTool({ accessToken: "real-looking-token", phoneNumberId: "123456" }, apiBaseUrl);
    const result = await tool.handler({ to: "15551234567", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to 15551234567");
    expect(result.content).toContain("wamid.HBg");

    expect(lastRequest?.url).toBe("/123456/messages");
    expect(lastRequest?.headers.authorization).toBe("Bearer real-looking-token");
    expect(JSON.parse(lastRequest!.body)).toEqual({ messaging_product: "whatsapp", to: "15551234567", type: "text", text: { body: "Hello from finanfa-code" } });
  });

  it("reports a WhatsApp-level rejection as a tool error with the real message", async () => {
    shouldError = true;
    const tool = createSendWhatsappMessageTool({ accessToken: "x", phoneNumberId: "123456" }, apiBaseUrl);
    const result = await tool.handler({ to: "999", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not in allowed list");
    shouldError = false;
  });

  it("reports a clear error when WhatsApp is not configured, instead of throwing", async () => {
    const tool = createSendWhatsappMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ to: "15551234567", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendWhatsappMessageTool({ accessToken: "x", phoneNumberId: "1" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("postWhatsappMessage retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          res.end(JSON.stringify({ error: { message: "Too many requests", code: 4 } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messages: [{ id: "wamid.retry" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("retries a real 429 (honoring the retry-after header) and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await postWhatsappMessage({ accessToken: "x", phoneNumberId: "1" }, { to: "1", text: "hi" }, apiBaseUrl);
    expect(result).toEqual({ ok: true, messageId: "wamid.retry" });
    expect(requestCount).toBe(2);
  });
});

describe("whatsappConfigFromEnv", () => {
  it("returns undefined when either env var is missing", () => {
    expect(whatsappConfigFromEnv({})).toBeUndefined();
    expect(whatsappConfigFromEnv({ WHATSAPP_ACCESS_TOKEN: "abc" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(whatsappConfigFromEnv({ WHATSAPP_PHONE_NUMBER_ID: "123" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(whatsappConfigFromEnv({ WHATSAPP_ACCESS_TOKEN: "abc", WHATSAPP_PHONE_NUMBER_ID: "123" } as NodeJS.ProcessEnv)).toEqual({
      accessToken: "abc",
      phoneNumberId: "123",
    });
  });
});
