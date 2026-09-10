import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { httpRequestTool } from "../../src/tools/builtin/http-request.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("http_request tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/echo") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ receivedMethod: req.method, receivedHeader: req.headers["x-custom"], receivedBody: body }));
          return;
        }
        if (req.url === "/notfound") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        if (req.url === "/slow") {
          setTimeout(() => res.end("too slow"), 2000);
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello world");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("GET returns status/headers/body, wrapped as untrusted content", async () => {
    const result = await httpRequestTool.handler({ url: `${baseUrl}/` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("HTTP 200");
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("untrusted-external-content");
  });

  it("POST sends a custom method, header, and body correctly", async () => {
    const result = await httpRequestTool.handler(
      {
        url: `${baseUrl}/echo`,
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Custom": "hello" },
        body: JSON.stringify({ x: 1 }),
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("HTTP 201");
    expect(result.content).toContain('"receivedMethod":"POST"');
    expect(result.content).toContain('"receivedHeader":"hello"');
    expect(result.content).toContain('"receivedBody":"{\\"x\\":1}"');
  });

  it("marks a non-2xx response as an error, without throwing", async () => {
    const result = await httpRequestTool.handler({ url: `${baseUrl}/notfound` }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("HTTP 404");
  });

  it("handles a connection refusal cleanly instead of throwing", async () => {
    const result = await httpRequestTool.handler({ url: "http://127.0.0.1:1/" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("times out cleanly on a slow response, instead of hanging", async () => {
    const result = await httpRequestTool.handler({ url: `${baseUrl}/slow`, timeout_ms: 300 }, ctx);
    expect(result.isError).toBe(true);
  }, 10_000);

  it(
    "real reported bug: Stop/interrupt (ctx.signal) cancels a slow request well before its own timeout, " +
      "instead of only ever stopping via the timeout",
    async () => {
      const controller = new AbortController();
      const runPromise = httpRequestTool.handler(
        { url: `${baseUrl}/slow`, timeout_ms: 30_000 },
        { cwd: "/tmp", sessionId: "test", signal: controller.signal },
      );
      const start = Date.now();
      setTimeout(() => controller.abort(), 100);
      const result = await runPromise;
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(result.isError).toBe(true);
    },
    10_000,
  );

  it("describeCall/riskKey show the method and URL", () => {
    const input = { url: `${baseUrl}/echo`, method: "DELETE" };
    expect(httpRequestTool.describeCall!(input)).toBe(`DELETE ${baseUrl}/echo`);
    expect(httpRequestTool.riskKey!(input)).toBe(`DELETE ${baseUrl}/echo`);
  });

  it("defaults to GET when no method is given", () => {
    const input = { url: `${baseUrl}/` };
    expect(httpRequestTool.describeCall!(input)).toBe(`GET ${baseUrl}/`);
  });
});
