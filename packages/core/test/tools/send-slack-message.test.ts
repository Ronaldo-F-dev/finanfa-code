import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendSlackMessageTool, slackConfigFromEnv } from "../../src/tools/builtin/send-slack-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_slack_message tool (real local HTTP server speaking Slack's chat.postMessage shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { headers: http.IncomingHttpHeaders; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { headers: req.headers, body };
        res.writeHead(200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ ok: false, error: "channel_not_found" }));
        } else {
          res.end(JSON.stringify({ ok: true, ts: "1234567890.123456" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    apiBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real authenticated request to chat.postMessage and reports success", async () => {
    const tool = createSendSlackMessageTool({ botToken: "xoxb-real-looking-token" }, apiBaseUrl);
    const result = await tool.handler({ channel: "#general", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message posted to #general");
    expect(result.content).toContain("1234567890.123456");

    expect(lastRequest?.headers.authorization).toBe("Bearer xoxb-real-looking-token");
    expect(JSON.parse(lastRequest!.body)).toEqual({ channel: "#general", text: "Hello from finanfa-code" });
  });

  it("reports a Slack-level rejection (ok:false) as a tool error with the real error code", async () => {
    shouldError = true;
    const tool = createSendSlackMessageTool({ botToken: "xoxb-token" }, apiBaseUrl);
    const result = await tool.handler({ channel: "#nonexistent", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("channel_not_found");
    shouldError = false;
  });

  it("reports a clear error when Slack is not configured, instead of throwing", async () => {
    const tool = createSendSlackMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ channel: "#general", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Slack is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendSlackMessageTool({ botToken: "x" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("slackConfigFromEnv", () => {
  it("returns undefined when SLACK_BOT_TOKEN is not set", () => {
    expect(slackConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(slackConfigFromEnv({ SLACK_BOT_TOKEN: "xoxb-abc" } as NodeJS.ProcessEnv)).toEqual({ botToken: "xoxb-abc" });
  });
});
