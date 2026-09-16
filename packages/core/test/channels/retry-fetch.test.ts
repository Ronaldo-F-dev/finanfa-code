import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithRetry } from "../../src/channels/retry-fetch.js";

describe("fetchWithRetry (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;
  let requestCount: number;
  let responsePlan: { status: number; body: string; headers?: Record<string, string> }[];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const step = responsePlan[Math.min(requestCount, responsePlan.length - 1)]!;
        requestCount++;
        res.writeHead(step.status, { "content-type": "application/json", ...step.headers });
        res.end(step.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("returns the first response immediately when it succeeds", async () => {
    requestCount = 0;
    responsePlan = [{ status: 200, body: '{"ok":true}' }];
    const { response, bodyText } = await fetchWithRetry(baseUrl, { method: "POST" });
    expect(response.status).toBe(200);
    expect(bodyText).toBe('{"ok":true}');
    expect(requestCount).toBe(1);
  });

  it("retries a 429 and succeeds on the next attempt, honoring a custom retryAfterMs", async () => {
    requestCount = 0;
    responsePlan = [
      { status: 429, body: '{"retry_after":0.01}', headers: {} },
      { status: 200, body: '{"ok":true}' },
    ];
    const start = Date.now();
    const { response, bodyText } = await fetchWithRetry(
      baseUrl,
      { method: "POST" },
      { retryAfterMs: (_res, body) => (JSON.parse(body) as { retry_after: number }).retry_after * 1000 },
    );
    expect(response.status).toBe(200);
    expect(bodyText).toBe('{"ok":true}');
    expect(requestCount).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(9); // the ~10ms server-specified wait actually elapsed
  });

  it("retries a 5xx with the generic exponential backoff (no retryAfterMs needed)", async () => {
    requestCount = 0;
    responsePlan = [
      { status: 503, body: "service unavailable" },
      { status: 200, body: '{"ok":true}' },
    ];
    const { response } = await fetchWithRetry(baseUrl, { method: "POST" }, { baseDelayMs: 5 });
    expect(response.status).toBe(200);
    expect(requestCount).toBe(2);
  });

  it("does not retry a plain 4xx (e.g. 400) — fails immediately", async () => {
    requestCount = 0;
    responsePlan = [{ status: 400, body: '{"error":"bad request"}' }];
    const { response } = await fetchWithRetry(baseUrl, { method: "POST" }, { baseDelayMs: 5 });
    expect(response.status).toBe(400);
    expect(requestCount).toBe(1);
  });

  it("gives up after maxAttempts and returns the last (still-failing) response", async () => {
    requestCount = 0;
    responsePlan = [{ status: 503, body: "down" }];
    const { response } = await fetchWithRetry(baseUrl, { method: "POST" }, { maxAttempts: 2, baseDelayMs: 5 });
    expect(response.status).toBe(503);
    expect(requestCount).toBe(2);
  });

  it("retries a real network-level failure (nothing listening), then throws once attempts are exhausted", async () => {
    // Port 1 is a real, permanently-closed privileged port on any normal
    // machine — a genuine ECONNREFUSED, not a mocked network error.
    await expect(fetchWithRetry("http://127.0.0.1:1/", { method: "POST" }, { maxAttempts: 2, baseDelayMs: 5 })).rejects.toThrow();
  });
});
