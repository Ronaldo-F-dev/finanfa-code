import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanCommandInjectionTool } from "../../../src/tools/builtin/security/command-injection.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_command_injection tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const host = url.searchParams.get("host") ?? "";
      if (url.pathname === "/vulnerable") {
        // Simulates a naive handler that really shells out with the value concatenated in.
        if (host.includes("id")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ping output\nuid=1000(app) gid=1000(app) groups=1000(app)");
          return;
        }
        if (host.includes("finanfa_nonexistent_cmd")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("sh: 1: finanfa_nonexistent_cmd_9f3a1: not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ping: unknown host");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ping: unknown host " + host);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'dangerous' risk level", () => {
    expect(securityScanCommandInjectionTool.riskLevel).toBe("dangerous");
  });

  it("confirms command injection via real recognizable 'id' output", async () => {
    const result = await securityScanCommandInjectionTool.handler({ url: `${baseUrl}/vulnerable?host=example.com` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("OS Command Injection in 'host'");
  });

  it("does not flag a safe handler that never reaches a shell", async () => {
    const result = await securityScanCommandInjectionTool.handler({ url: `${baseUrl}/safe?host=example.com` }, ctx);
    expect(result.content).toContain("No OS command injection detected");
  });
});
