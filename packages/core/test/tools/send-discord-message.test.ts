import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendDiscordMessageTool, discordConfigFromEnv, patchDiscordInteractionResponse } from "../../src/tools/builtin/send-discord-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_discord_message tool (real local HTTP server speaking Discord's create-message shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
  let statusToReturn = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
        res.writeHead(statusToReturn, { "content-type": "application/json" });
        if (statusToReturn >= 400) {
          res.end(JSON.stringify({ message: "Missing Access", code: 50001 }));
        } else {
          res.end(JSON.stringify({ id: "999888777" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real authenticated request to the right channel and reports success", async () => {
    const tool = createSendDiscordMessageTool({ botToken: "real-looking-bot-token" }, apiBaseUrl);
    const result = await tool.handler({ channelId: "123456", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to channel 123456");
    expect(result.content).toContain("999888777");

    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/channels/123456/messages");
    expect(lastRequest?.headers.authorization).toBe("Bot real-looking-bot-token");
    expect(JSON.parse(lastRequest!.body)).toEqual({ content: "Hello from finanfa-code" });
  });

  it("reports a Discord-level rejection as a tool error with the real message", async () => {
    statusToReturn = 403;
    const tool = createSendDiscordMessageTool({ botToken: "x" }, apiBaseUrl);
    const result = await tool.handler({ channelId: "999", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Missing Access");
    statusToReturn = 200;
  });

  it("reports a clear error when Discord is not configured, instead of throwing", async () => {
    const tool = createSendDiscordMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ channelId: "123456", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Discord is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendDiscordMessageTool({ botToken: "x" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("patchDiscordInteractionResponse (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "1" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("PATCHes the deferred response at the right webhook URL, with no bot-token auth header", async () => {
    const result = await patchDiscordInteractionResponse("app123", "interaction-token-abc", "final reply", apiBaseUrl);
    expect(result.ok).toBe(true);
    expect(lastRequest?.method).toBe("PATCH");
    expect(lastRequest?.url).toBe("/webhooks/app123/interaction-token-abc/messages/@original");
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect(JSON.parse(lastRequest!.body)).toEqual({ content: "final reply" });
  });
});

describe("discordConfigFromEnv", () => {
  it("returns undefined when DISCORD_BOT_TOKEN is not set", () => {
    expect(discordConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(discordConfigFromEnv({ DISCORD_BOT_TOKEN: "abc" } as NodeJS.ProcessEnv)).toEqual({ botToken: "abc" });
  });
});
