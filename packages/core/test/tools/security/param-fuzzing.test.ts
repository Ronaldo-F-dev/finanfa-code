import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanParamFuzzingTool } from "../../../src/tools/builtin/security/param-fuzzing.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_param_fuzzing tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const id = url.searchParams.get("id") ?? "";
      if (url.pathname === "/vulnerable") {
        // Naive handler: crashes (simulated) on an empty value, as if
        // parseInt("").toString() or similar blew up unhandled — but
        // handles everything else fine, including other fuzz payloads.
        if (id === "") {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Traceback (most recent call last):\n  File \"app.py\", line 42\nValueError: invalid literal");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok, handles everything");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("flags a real unhandled 500 with a leaked stack trace on malformed input", async () => {
    const result = await securityScanParamFuzzingTool.handler({ url: `${baseUrl}/vulnerable?id=1` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Unhandled Server Error on Malformed Input in 'id'");
    expect(result.content).toContain("stack trace is disclosed");
  });

  it("does not flag a robust handler that survives every fuzz payload", async () => {
    const result = await securityScanParamFuzzingTool.handler({ url: `${baseUrl}/safe?id=1` }, ctx);
    expect(result.content).toContain("No input validation issues found");
  });

  it("reports nothing to fuzz for a URL with no query parameters", async () => {
    const result = await securityScanParamFuzzingTool.handler({ url: `${baseUrl}/safe` }, ctx);
    expect(result.content).toContain("No parameters found to fuzz");
  });
});
