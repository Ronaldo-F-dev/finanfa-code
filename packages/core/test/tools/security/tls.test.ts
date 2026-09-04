import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { securityScanTlsTool } from "../../../src/tools/builtin/security/tls.js";

const execFileAsync = promisify(execFile);
const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_tls tool (real TLS handshake against a local server)", () => {
  let dir: string;
  let server: tls.Server;
  let baseUrl: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-tls-test-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    // A real, freshly-generated self-signed cert (not a fixture/mock) —
    // -days 90 keeps it comfortably outside the 30-day "expiring soon"
    // window this scanner checks for.
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "90",
      "-subj",
      "/CN=localhost",
    ]);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);

    server = tls.createServer({ key, cert }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `https://127.0.0.1:${port}`;
  }, 20_000);

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("has 'ask' risk level", () => {
    expect(securityScanTlsTool.riskLevel).toBe("ask");
  });

  it("reports the negotiated protocol/cipher as passed controls for a healthy, freshly-issued cert", async () => {
    const result = await securityScanTlsTool.handler({ url: baseUrl }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Weak TLS Protocol");
    expect(result.content).not.toContain("Certificate Expir");
    expect(result.content).toContain("TLS protocol");
  });

  it(
    "flags a cert expiring within 30 days as a real finding, verified against an actual short-lived cert",
    async () => {
      const shortDir = await mkdtemp(path.join(tmpdir(), "finanfa-tls-short-"));
      const keyPath = path.join(shortDir, "key.pem");
      const certPath = path.join(shortDir, "cert.pem");
      await execFileAsync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ]);
      const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
      const shortServer = tls.createServer({ key, cert }, (socket) => socket.end());
      try {
        await new Promise<void>((resolve) => shortServer.listen(0, "127.0.0.1", resolve));
        const port = (shortServer.address() as AddressInfo).port;

        const result = await securityScanTlsTool.handler({ url: `https://127.0.0.1:${port}` }, ctx);
        expect(result.content).toContain("TLS Certificate Expiring Soon");
      } finally {
        shortServer.close();
        await rm(shortDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("flags plaintext http:// as a finding without attempting a TLS handshake", async () => {
    const result = await securityScanTlsTool.handler({ url: "http://example.com" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Target Served Over Plaintext HTTP");
  });

  it("rejects a malformed URL with a clear error", async () => {
    const result = await securityScanTlsTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a valid URL");
  });

  it("resolves quietly (no findings, no crash) when nothing is listening on the target port", async () => {
    const result = await securityScanTlsTool.handler({ url: "https://127.0.0.1:1" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No findings");
  });
});
