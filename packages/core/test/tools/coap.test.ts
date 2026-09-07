import { describe, expect, it, beforeAll, afterAll } from "vitest";
import coap from "coap";
import { coapRequestTool } from "../../src/tools/builtin/coap.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("coap_request tool (real local CoAP server, real UDP)", () => {
  let server: coap.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = coap.createServer((req, res) => {
      if (req.method === "GET" && req.url.startsWith("/sensors/temperature")) {
        res.end("21.5");
        return;
      }
      if (req.method === "POST" && req.url === "/actuators/relay") {
        res.code = "2.04";
        res.end(`switched: ${req.payload.toString("utf-8")}`);
        return;
      }
      if (req.url === "/notfound") {
        res.code = "4.04";
        res.end("not found");
        return;
      }
      if (req.url === "/sensors/live" && req.headers.Observe === 0) {
        // Real observe support: each res.write() sends a new notification
        // over the same observe stream, matching coap's own documented
        // server-side observe pattern.
        let count = 0;
        const interval = setInterval(() => {
          count++;
          res.write(`reading ${count}`);
          if (count >= 3) clearInterval(interval);
        }, 50);
        return;
      }
      res.code = "2.05";
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const port = (server as unknown as { _sock: { address(): { port: number } } })._sock.address().port;
    baseUrl = `coap://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'ask' risk level (mutating methods send real requests to real devices)", () => {
    expect(coapRequestTool.riskLevel).toBe("ask");
  });

  it("performs a real GET and returns the real payload", async () => {
    const result = await coapRequestTool.handler({ uri: `${baseUrl}/sensors/temperature` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("21.5");
  });

  it("performs a real POST with a payload and gets the real echoed response", async () => {
    const result = await coapRequestTool.handler({ uri: `${baseUrl}/actuators/relay`, method: "POST", payload: "on" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("switched: on");
  });

  it("reports a real 4.xx CoAP response as isError", async () => {
    const result = await coapRequestTool.handler({ uri: `${baseUrl}/notfound` }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("4.04");
  });

  it("rejects a non-coap:// URI without sending anything", async () => {
    const result = await coapRequestTool.handler({ uri: "http://example.com" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("times out cleanly against an unreachable host instead of hanging", async () => {
    const result = await coapRequestTool.handler({ uri: "coap://192.0.2.1/x", timeout_ms: 500 }, ctx);
    expect(result.isError).toBe(true);
  }, 5_000);

  it("collects real observe notifications from a real observe-enabled resource", async () => {
    const result = await coapRequestTool.handler({ uri: `${baseUrl}/sensors/live`, observe: true, timeout_ms: 1000 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("reading 1");
    expect(result.content).toContain("reading 2");
  }, 5_000);

  it("scopes the riskKey by method", () => {
    expect(coapRequestTool.riskKey?.({ uri: "coap://x/y", method: "POST" })).toBe("coap_request:POST");
    expect(coapRequestTool.riskKey?.({ uri: "coap://x/y" })).toBe("coap_request:GET");
  });
});
