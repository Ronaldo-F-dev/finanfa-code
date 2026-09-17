import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendMatrixMessageTool, matrixConfigFromEnv, postMatrixMessage } from "../../src/tools/builtin/send-matrix-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_matrix_message tool (real local HTTP server speaking the Matrix Client-Server API shape)", () => {
  let server: http.Server;
  let homeserverUrl: string;
  let lastRequest: { method: string | undefined; url: string; authHeader: string | undefined; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { method: req.method, url: req.url ?? "", authHeader: req.headers.authorization, body };
        res.writeHead(200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ errcode: "M_FORBIDDEN", error: "You are not in this room." }));
        } else {
          res.end(JSON.stringify({ event_id: "$real-event-id" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    homeserverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("PUTs a real send-event request with the real Bearer token and reports success", async () => {
    const tool = createSendMatrixMessageTool({ homeserverUrl, asToken: "as-real-looking-token" });
    const result = await tool.handler({ roomId: "!room1:example.org", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to !room1:example.org");
    expect(result.content).toContain("$real-event-id");

    expect(lastRequest?.method).toBe("PUT");
    expect(lastRequest?.url).toMatch(/^\/_matrix\/client\/v3\/rooms\/!room1%3Aexample\.org\/send\/m\.room\.message\/[^/]+$/);
    expect(lastRequest?.authHeader).toBe("Bearer as-real-looking-token");
    expect(JSON.parse(lastRequest!.body)).toEqual({ msgtype: "m.text", body: "Hello from finanfa-code" });
  });

  it("reports a real Matrix error (errcode) as a tool error", async () => {
    shouldError = true;
    const tool = createSendMatrixMessageTool({ homeserverUrl, asToken: "as-token" });
    const result = await tool.handler({ roomId: "!room1:example.org", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not in this room");
    shouldError = false;
  });

  it("reports a clear error when Matrix is not configured, instead of throwing", async () => {
    const tool = createSendMatrixMessageTool(undefined);
    const result = await tool.handler({ roomId: "!room1:example.org", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Matrix is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendMatrixMessageTool({ homeserverUrl, asToken: "x" }).riskLevel).toBe("ask");
  });
});

describe("postMatrixMessage retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let homeserverUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ errcode: "M_UNKNOWN", error: "Internal server error" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ event_id: "$after-retry" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    homeserverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("retries a real 5xx and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await postMatrixMessage({ homeserverUrl, asToken: "as-token" }, { roomId: "!r:example.org", text: "hi" });
    expect(result).toEqual({ ok: true, eventId: "$after-retry" });
    expect(requestCount).toBe(2);
  });
});

describe("matrixConfigFromEnv", () => {
  it("returns undefined when either MATRIX_HOMESERVER_URL or MATRIX_AS_TOKEN is missing", () => {
    expect(matrixConfigFromEnv({})).toBeUndefined();
    expect(matrixConfigFromEnv({ MATRIX_HOMESERVER_URL: "https://matrix.example.org" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(matrixConfigFromEnv({ MATRIX_AS_TOKEN: "t" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(matrixConfigFromEnv({ MATRIX_HOMESERVER_URL: "https://matrix.example.org", MATRIX_AS_TOKEN: "t" } as NodeJS.ProcessEnv)).toEqual({
      homeserverUrl: "https://matrix.example.org",
      asToken: "t",
    });
  });
});
