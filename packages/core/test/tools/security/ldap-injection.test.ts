import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanLdapInjectionTool } from "../../../src/tools/builtin/security/ldap-injection.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_ldap_injection tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const uid = url.searchParams.get("uid") ?? "";
      if (url.pathname === "/vulnerable" && uid.includes("*)(uid=*")) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("javax.naming.NamingException: [LDAP: error code 87 - Bad search filter]");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("no results");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'dangerous' risk level", () => {
    expect(securityScanLdapInjectionTool.riskLevel).toBe("dangerous");
  });

  it("confirms LDAP injection via a real matched LDAP error signature", async () => {
    const result = await securityScanLdapInjectionTool.handler({ url: `${baseUrl}/vulnerable?uid=bob` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("LDAP Injection in 'uid'");
  });

  it("does not flag a safe handler", async () => {
    const result = await securityScanLdapInjectionTool.handler({ url: `${baseUrl}/safe?uid=bob` }, ctx);
    expect(result.content).toContain("No LDAP injection detected");
  });
});
