import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanWebsocketTool } from "../../../src/tools/builtin/security/websocket.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_websocket tool (real local HTTP server simulating Socket.IO)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/socket.io/?EIO=4")) {
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end('0{"sid":"abc123","upgrades":[],"pingInterval":25000,"pingTimeout":5000}');
        return;
      }
      if (req.url === "/socket.io/socket.io.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("/* Socket.IO v4.7.2 */\nfunction io(){}");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms auth-free handshake, CORS wildcard, and version disclosure against a real Socket.IO-like server", async () => {
    const result = await securityScanWebsocketTool.handler({ url: baseUrl }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Socket.IO Handshake Accepted Without Authentication");
    expect(result.content).toContain("Socket.IO CORS Allows Arbitrary Origins");
    expect(result.content).toContain("Socket.IO Client Script Reveals Version");
    expect(result.content).toContain("4.7.2");
  });

  it("reports no Socket.IO server detected for a plain server", async () => {
    const other = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const port = (other.address() as AddressInfo).port;
    try {
      const result = await securityScanWebsocketTool.handler({ url: `http://127.0.0.1:${port}` }, ctx);
      expect(result.content).toContain("No Socket.IO server detected");
    } finally {
      other.close();
    }
  });
});
