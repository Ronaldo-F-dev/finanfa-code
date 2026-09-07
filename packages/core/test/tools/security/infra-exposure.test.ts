import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { securityScanInfraExposureTool, checkRedis, checkMysql, checkPostgresql, checkMssql } from "../../../src/tools/builtin/security/infra-exposure.js";

function listenOn(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

describe("security_scan_infra_exposure tool (real TCP servers speaking the actual wire protocols)", () => {
  let server: net.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("has 'ask' risk level", () => {
    expect(securityScanInfraExposureTool.riskLevel).toBe("ask");
  });

  it("rejects a malformed URL", async () => {
    const result = await securityScanInfraExposureTool.handler({ url: "not a url" }, { cwd: "/tmp", sessionId: "t", signal: new AbortController().signal });
    expect(result.isError).toBe(true);
  });

  describe("Redis (RESP protocol)", () => {
    it("confirms exposure when the server responds +PONG with no auth", async () => {
      server = net.createServer((socket) => socket.on("data", () => socket.write("+PONG\r\n")));
      const port = await listenOn(server);
      const finding = await checkRedis("127.0.0.1", port);
      expect(finding?.title).toContain("Redis Exposed on Default Port Without Authentication");
    });

    it("does not flag a Redis that requires authentication (-NOAUTH)", async () => {
      server = net.createServer((socket) => socket.on("data", () => socket.write("-NOAUTH Authentication required.\r\n")));
      const port = await listenOn(server);
      const finding = await checkRedis("127.0.0.1", port);
      expect(finding).toBeUndefined();
    });
  });

  describe("MySQL (native password handshake)", () => {
    function buildHandshake(salt: Buffer): Buffer {
      // Minimal but real MySQL initial handshake packet (protocol 10),
      // shaped exactly as parseMysqlHandshake expects.
      const salt1 = salt.subarray(0, 8);
      const salt2 = salt.subarray(8, 20);
      const payload = Buffer.concat([
        Buffer.from([0x0a]), // protocol version 10
        Buffer.from("8.0.30\0", "latin1"), // server version, NUL-terminated
        Buffer.from([1, 0, 0, 0]), // connection id
        salt1,
        Buffer.from([0x00]), // filler
        Buffer.from([0xff, 0xff]), // capability flags (lower)
        Buffer.from([0x21]), // charset
        Buffer.from([0x02, 0x00]), // status flags
        Buffer.from([0xff, 0xff]), // capability flags (upper)
        Buffer.from([21]), // auth plugin data length (8 + 13)
        Buffer.alloc(10), // reserved
        salt2,
        Buffer.from([0x00]),
        Buffer.from("mysql_native_password\0", "latin1"),
      ]);
      const header = Buffer.alloc(4);
      header.writeUIntLE(payload.length, 0, 3);
      header[3] = 0;
      return Buffer.concat([header, payload]);
    }

    function nativePasswordResponse(password: string, salt: Buffer): Buffer {
      if (!password) return Buffer.alloc(0);
      const stage1 = createHash("sha1").update(password).digest();
      const stage2 = createHash("sha1").update(stage1).digest();
      const stage3 = createHash("sha1").update(Buffer.concat([salt, stage2])).digest();
      return Buffer.from(stage1.map((b, i) => b ^ stage3[i]));
    }

    it("confirms access when the empty-password credential is accepted (real HS256-style handshake exchange)", async () => {
      const salt = Buffer.from("0123456789abc", "latin1"); // 13 bytes: 8 + 5, padded below to 20 total by the fake server
      const fullSalt = Buffer.concat([salt, Buffer.alloc(20 - salt.length)]).subarray(0, 20);

      server = net.createServer((socket) => {
        socket.write(buildHandshake(fullSalt));
        socket.once("data", (clientAuth) => {
          // Real verification: does the client's auth response match what
          // an EMPTY password ("root"/"") would produce for this salt?
          const expectedForEmpty = nativePasswordResponse("", fullSalt);
          const looksEmpty = expectedForEmpty.length === 0;
          // The handshake response payload ends with the auth response
          // length byte followed by the bytes themselves, then the plugin
          // name — find them by locating "mysql_native_password" and
          // walking back, since we control the exact format we emit.
          const marker = Buffer.from("mysql_native_password\0", "latin1");
          const markerIdx = clientAuth.indexOf(marker);
          const authLen = clientAuth[markerIdx - 1];
          const authBytes = clientAuth.subarray(markerIdx - 1 - authLen, markerIdx - 1);
          const accepted = looksEmpty ? authLen === 0 : authBytes.equals(nativePasswordResponse("root", fullSalt));
          socket.write(accepted ? Buffer.from([7, 0, 0, 2, 0x00, 0, 0, 2, 0, 0, 0]) : Buffer.from([1, 0, 0, 2, 0xff]));
        });
      });
      const port = await listenOn(server);
      const finding = await checkMysql("127.0.0.1", port);
      expect(finding?.title).toContain("MySQL Accessible With Default Credentials");
      expect(finding?.description).toContain("root");
    });

    it("does not flag MySQL when every default credential is rejected", async () => {
      const fullSalt = Buffer.alloc(20, 0x41);
      server = net.createServer((socket) => {
        socket.write(buildHandshake(fullSalt));
        socket.once("data", () => socket.write(Buffer.from([1, 0, 0, 2, 0xff]))); // ERR packet
      });
      const port = await listenOn(server);
      const finding = await checkMysql("127.0.0.1", port);
      expect(finding).toBeUndefined();
    });
  });

  describe("PostgreSQL (frontend/backend protocol v3)", () => {
    it("confirms 'no password at all' when AuthenticationOk arrives immediately", async () => {
      server = net.createServer((socket) => {
        socket.once("data", () => {
          const msg = Buffer.alloc(9);
          msg[0] = 0x52; // 'R'
          msg.writeUInt32BE(8, 1); // length
          msg.writeUInt32BE(0, 5); // auth type 0 = AuthenticationOk
          socket.write(msg);
        });
      });
      const port = await listenOn(server);
      const finding = await checkPostgresql("127.0.0.1", port);
      expect(finding?.title).toContain("PostgreSQL Accepts Connections Without a Password");
    });

    it("does not flag Postgres when cleartext-password auth is required and rejects the default credentials", async () => {
      let call = 0;
      server = net.createServer((socket) => {
        socket.on("data", () => {
          call++;
          if (call === 1) {
            const msg = Buffer.alloc(9);
            msg[0] = 0x52;
            msg.writeUInt32BE(8, 1);
            msg.writeUInt32BE(3, 5); // auth type 3 = cleartext password required
            socket.write(msg);
          } else {
            const msg = Buffer.from("E\x00\x00\x00\x08err\x00", "latin1");
            socket.write(msg);
          }
        });
      });
      const port = await listenOn(server);
      const finding = await checkPostgresql("127.0.0.1", port);
      expect(finding).toBeUndefined();
    });
  });

  describe("MSSQL (TDS PRELOGIN reachability)", () => {
    it("reports informational reachability when a TDS PRELOGIN response comes back", async () => {
      server = net.createServer((socket) => {
        socket.once("data", () => {
          const response = Buffer.alloc(16);
          response[0] = 0x04; // TABULAR_RESULT
          socket.write(response);
        });
      });
      const port = await listenOn(server);
      const finding = await checkMssql("127.0.0.1", port);
      expect(finding?.title).toContain("MSSQL Port Reachable");
      expect(finding?.severity).toBe("INFO");
    });

    it("does not flag a port that doesn't speak TDS at all", async () => {
      server = net.createServer((socket) => socket.write("not tds"));
      const port = await listenOn(server);
      const finding = await checkMssql("127.0.0.1", port);
      expect(finding).toBeUndefined();
    });
  });
});
