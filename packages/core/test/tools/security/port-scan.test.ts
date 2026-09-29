import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { securityScanPortsTool } from "../../../src/tools/builtin/security/port-scan.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

function listenOn(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** A port with nothing listening on 127.0.0.1 — connecting gets ECONNREFUSED (closed), not a timeout. */
function findClosedPort(server: net.Server): number {
  const port = (server.address() as AddressInfo).port;
  server.close();
  return port;
}

describe("security_scan_ports tool (real TCP listeners, no mocks)", () => {
  let servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
  });

  it("has 'ask' risk level", () => {
    expect(securityScanPortsTool.riskLevel).toBe("ask");
  });

  it("reports a real open port as open", async () => {
    const server = net.createServer((socket) => socket.on("data", () => {}));
    servers.push(server);
    const port = await listenOn(server);

    const result = await securityScanPortsTool.handler({ host: "127.0.0.1", ports: [port] }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`${port}/tcp`);
    expect(result.content).toContain("1 open");
  });

  it("reports a closed port (nothing listening) as closed within a reasonable timeout", async () => {
    const probe = net.createServer();
    await listenOn(probe);
    const closedPort = findClosedPort(probe);

    const result = await securityScanPortsTool.handler({ host: "127.0.0.1", ports: [closedPort] }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("0 open");
    expect(result.content).toContain("Closed: 1");
  }, 8_000);

  it("scans an explicit port list containing both an open and a closed port", async () => {
    const openServer = net.createServer((socket) => socket.on("data", () => {}));
    servers.push(openServer);
    const openPort = await listenOn(openServer);

    const closedProbe = net.createServer();
    await listenOn(closedProbe);
    const closedPort = findClosedPort(closedProbe);

    const result = await securityScanPortsTool.handler({ host: "127.0.0.1", ports: [openPort, closedPort] }, ctx);

    expect(result.content).toContain("2 port(s) checked");
    expect(result.content).toContain(`${openPort}/tcp`);
    expect(result.content).toContain("1 open");
    expect(result.content).toContain("Closed: 1");
  }, 8_000);

  it("scans a port range via startPort/endPort", async () => {
    const server = net.createServer((socket) => socket.on("data", () => {}));
    servers.push(server);
    const openPort = await listenOn(server);

    const result = await securityScanPortsTool.handler({ host: "127.0.0.1", startPort: openPort, endPort: openPort + 4 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("5 port(s) checked");
    expect(result.content).toContain(`${openPort}/tcp`);
  }, 8_000);

  it("rejects an invalid port range", async () => {
    const result = await securityScanPortsTool.handler({ host: "127.0.0.1", startPort: 100, endPort: 50 }, ctx);
    expect(result.isError).toBe(true);
  });

  it("rejects a port count over the per-scan cap", async () => {
    const result = await securityScanPortsTool.handler({ host: "127.0.0.1", startPort: 1, endPort: 60000 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds");
  });

  it("respects a concurrency cap: scanning past it takes multiple batches, not one", async () => {
    // 192.0.2.1 (TEST-NET-1, RFC 5737) is guaranteed unreachable and never
    // responds, so every attempt blocks for the tool's full 3s connect
    // timeout. With an unlimited-concurrency scan, 100 ports would all time
    // out in parallel (~3s total). With the tool's documented 50-connection
    // cap, 100 ports needs two sequential batches (~6s+). This measures the
    // cap's real effect on wall-clock time rather than trying to sample an
    // internal counter, which is unreliable when connects resolve near-instantly.
    const ports = Array.from({ length: 100 }, (_, i) => 20000 + i);
    const start = Date.now();
    const result = await securityScanPortsTool.handler({ host: "192.0.2.1", ports }, ctx);
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
  }, 15_000);

  it("does not hang against a completely unreachable host", async () => {
    const start = Date.now();
    const result = await securityScanPortsTool.handler({ host: "192.0.2.1", ports: [80] }, ctx);
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(false);
    expect(elapsed).toBeLessThan(6_000);
  }, 8_000);
});
