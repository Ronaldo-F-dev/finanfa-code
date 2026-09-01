import { describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { waitForPortTool } from "../../src/tools/builtin/wait-for-port.js";

function listenOnRandomPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe("wait_for_port tool (real TCP connections)", () => {
  it("returns immediately when the port is already accepting connections", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const result = await waitForPortTool.handler({ port, host: "127.0.0.1" }, {} as any);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("1 attempt");
    } finally {
      server.close();
    }
  });

  it("polls until a server starts listening partway through, instead of failing immediately", async () => {
    const port = 39217; // picked and asserted closed first, to avoid a flaky real port collision
    const closedCheck = await waitForPortTool.handler({ port, host: "127.0.0.1", timeout_ms: 200 }, {} as any);
    expect(closedCheck.isError).toBe(true);

    let server: net.Server | undefined;
    setTimeout(() => {
      server = net.createServer().listen(port, "127.0.0.1");
    }, 300);

    try {
      const result = await waitForPortTool.handler({ port, host: "127.0.0.1", timeout_ms: 3000 }, {} as any);
      expect(result.isError).toBe(false);
    } finally {
      server?.close();
    }
  }, 10_000);

  it("reports failure after the timeout when nothing is ever listening", async () => {
    const result = await waitForPortTool.handler({ port: 39218, host: "127.0.0.1", timeout_ms: 300 }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not accept connections");
  });
});
