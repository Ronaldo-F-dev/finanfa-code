import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendSmsMessageTool, smsConfigFromEnv, postSmsMessage } from "../../src/tools/builtin/send-sms-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_sms_message tool (real local HTTP server speaking Twilio's Messages API shape)", () => {
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
        res.writeHead(shouldError ? 400 : 201, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number." }));
        } else {
          res.end(JSON.stringify({ sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", status: "queued" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real Basic-Auth-authenticated request and reports success", async () => {
    const tool = createSendSmsMessageTool({ accountSid: "ACxxxx", authToken: "real-looking-token", fromNumber: "+15559876543" }, apiBaseUrl);
    const result = await tool.handler({ to: "+15551234567", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to +15551234567");
    expect(result.content).toContain("SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    expect(lastRequest?.url).toBe("/Accounts/ACxxxx/Messages.json");
    expect(lastRequest?.headers.authorization).toBe(`Basic ${Buffer.from("ACxxxx:real-looking-token").toString("base64")}`);
    expect(lastRequest?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(lastRequest!.body);
    expect(params.get("To")).toBe("+15551234567");
    expect(params.get("From")).toBe("+15559876543");
    expect(params.get("Body")).toBe("Hello from finanfa-code");
  });

  it("reports a Twilio-level rejection as a tool error with the real message", async () => {
    shouldError = true;
    const tool = createSendSmsMessageTool({ accountSid: "ACxxxx", authToken: "x", fromNumber: "+1" }, apiBaseUrl);
    const result = await tool.handler({ to: "invalid", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a valid phone number");
    shouldError = false;
  });

  it("reports a clear error when SMS is not configured, instead of throwing", async () => {
    const tool = createSendSmsMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ to: "+15551234567", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendSmsMessageTool({ accountSid: "AC", authToken: "x", fromNumber: "+1" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("postSmsMessage retry behavior (real local HTTP server)", () => {
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
          res.end(JSON.stringify({ code: 20429, message: "Too many requests" }));
          return;
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ sid: "SMretry" }));
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
    const result = await postSmsMessage({ accountSid: "AC", authToken: "x", fromNumber: "+1" }, { to: "+1", text: "hi" }, apiBaseUrl);
    expect(result).toEqual({ ok: true, messageSid: "SMretry" });
    expect(requestCount).toBe(2);
  });
});

describe("smsConfigFromEnv", () => {
  it("returns undefined when any env var is missing", () => {
    expect(smsConfigFromEnv({})).toBeUndefined();
    expect(smsConfigFromEnv({ TWILIO_ACCOUNT_SID: "AC" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(smsConfigFromEnv({ TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+15559876543" } as NodeJS.ProcessEnv)).toEqual({
      accountSid: "AC",
      authToken: "tok",
      fromNumber: "+15559876543",
    });
  });
});
