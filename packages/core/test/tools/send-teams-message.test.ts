import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendTeamsMessageTool, teamsConfigFromEnv, postTeamsMessage } from "../../src/tools/builtin/send-teams-message.js";
import { resetTeamsTokenCacheForTests } from "../../src/core/teams-token.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_teams_message tool (real local HTTP server speaking Microsoft's OAuth2 + Bot Framework Connector API shapes)", () => {
  let server: http.Server;
  let serviceUrl: string;
  let tokenUrl: string;
  let lastSendRequest: { method: string | undefined; url: string; authHeader: string | undefined; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "real-looking-connector-token", expires_in: 3600 }));
          return;
        }
        lastSendRequest = { method: req.method, url: req.url ?? "", authHeader: req.headers.authorization, body };
        if (shouldError) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "BadArgument", message: "Invalid conversation id" } }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "activity-out-1" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    serviceUrl = `http://127.0.0.1:${port}`;
    tokenUrl = `http://127.0.0.1:${port}/token`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetTeamsTokenCacheForTests();
    shouldError = false;
  });

  it("fetches a real OAuth2 token, then posts a new activity authenticated with it", async () => {
    const tool = createSendTeamsMessageTool({ appId: "app-1", appPassword: "s" }, tokenUrl);
    const result = await tool.handler({ serviceUrl, conversationId: "conv-1", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to conversation conv-1");
    expect(result.content).toContain("activity-out-1");

    expect(lastSendRequest?.method).toBe("POST");
    expect(lastSendRequest?.url).toBe("/v3/conversations/conv-1/activities");
    expect(lastSendRequest?.authHeader).toBe("Bearer real-looking-connector-token");
    expect(JSON.parse(lastSendRequest!.body)).toEqual({ type: "message", text: "Hello from finanfa-code" });
  });

  it("posts to the reply-to-activity URL when replyToActivityId is given", async () => {
    const tool = createSendTeamsMessageTool({ appId: "app-1", appPassword: "s" }, tokenUrl);
    await tool.handler({ serviceUrl, conversationId: "conv-1", text: "a reply", replyToActivityId: "activity-in-1" }, ctx);
    expect(lastSendRequest?.url).toBe("/v3/conversations/conv-1/activities/activity-in-1");
  });

  it("reports a real Bot Framework connector error as a tool error", async () => {
    shouldError = true;
    const tool = createSendTeamsMessageTool({ appId: "app-1", appPassword: "s" }, tokenUrl);
    const result = await tool.handler({ serviceUrl, conversationId: "invalid", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid conversation id");
  });

  it("reports a clear error when Teams is not configured, instead of throwing", async () => {
    const tool = createSendTeamsMessageTool(undefined, tokenUrl);
    const result = await tool.handler({ serviceUrl, conversationId: "conv-1", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Teams is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendTeamsMessageTool({ appId: "a", appPassword: "s" }, tokenUrl).riskLevel).toBe("ask");
  });
});

describe("postTeamsMessage retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let serviceUrl: string;
  let tokenUrl: string;
  let sendRequestCount = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.url === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "t", expires_in: 3600 }));
          return;
        }
        sendRequestCount++;
        if (sendRequestCount === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "internal error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "activity-out-2" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    serviceUrl = `http://127.0.0.1:${port}`;
    tokenUrl = `http://127.0.0.1:${port}/token`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetTeamsTokenCacheForTests();
  });

  it("retries a real 5xx on the send-activity call and succeeds on the next attempt", async () => {
    const result = await postTeamsMessage({ appId: "app-1", appPassword: "s" }, { serviceUrl, conversationId: "conv-1", text: "hi" }, tokenUrl);
    expect(result).toEqual({ ok: true, activityId: "activity-out-2" });
  });
});

describe("teamsConfigFromEnv", () => {
  it("returns undefined when either MICROSOFT_APP_ID or MICROSOFT_APP_PASSWORD is missing", () => {
    expect(teamsConfigFromEnv({})).toBeUndefined();
    expect(teamsConfigFromEnv({ MICROSOFT_APP_ID: "a" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(teamsConfigFromEnv({ MICROSOFT_APP_PASSWORD: "s" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(teamsConfigFromEnv({ MICROSOFT_APP_ID: "a", MICROSOFT_APP_PASSWORD: "s" } as NodeJS.ProcessEnv)).toEqual({ appId: "a", appPassword: "s" });
  });
});
