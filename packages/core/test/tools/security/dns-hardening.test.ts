import { describe, expect, it, beforeAll, afterAll } from "vitest";
import dgram from "node:dgram";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { securityScanDnsHardeningTool, checkDnssec, udpDnsQuery, parseAxfrStream, attemptZoneTransferAgainst } from "../../../src/tools/builtin/security/dns-hardening.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_dns_hardening tool (real DNS queries against real domains)", () => {
  it("has 'ask' risk level", () => {
    expect(securityScanDnsHardeningTool.riskLevel).toBe("ask");
  });

  it("rejects a malformed URL", async () => {
    const result = await securityScanDnsHardeningTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });

  it(
    "discovers real, well-known subdomains for google.com (www, mail at least)",
    async () => {
      const result = await securityScanDnsHardeningTool.handler({ url: "https://google.com" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Additional Subdomains Discovered");
      expect(result.content).toContain("www.google.com");
    },
    20_000,
  );

  it(
    "confirms real DNSSEC on cloudflare.com by querying a real public resolver (1.1.1.1) directly",
    async () => {
      // Isolated from the full tool/AXFR path: this sandbox's outbound TCP:53
      // to some real nameserver IPs appears to be silently dropped rather
      // than refused, making the full AXFR-over-TCP attempt (tried below
      // against a fake local server instead, where it's fast and
      // deterministic) too slow here to keep as part of an end-to-end test.
      expect(await checkDnssec("cloudflare.com")).toBe(true);
    },
    15_000,
  );

  it(
    "flags DNSSEC Not Enabled for a nonexistent subdomain (real NXDOMAIN response)",
    async () => {
      const result = await securityScanDnsHardeningTool.handler({ url: "https://this-really-does-not-exist-finanfa-test-99999.example.com" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("DNSSEC Not Enabled");
    },
    20_000,
  );
});

describe("checkDnssec (real UDP DNS wire protocol against fake local resolvers)", () => {
  let qnameAwareServer: dgram.Socket;
  let qnameAwarePort: number;
  let notimpServer: dgram.Socket;
  let notimpPort: number;
  let lastQtype: number | undefined;

  beforeAll(async () => {
    qnameAwareServer = dgram.createSocket("udp4");
    qnameAwareServer.on("message", (msg, rinfo) => {
      lastQtype = msg.readUInt16BE(msg.length - 4);
      const reply = Buffer.from(msg);
      reply[3] = reply[3]! & 0xf0; // NOERROR
      const hasDnskey = msg.toString("latin1").includes("hasdnskey");
      reply.writeUInt16BE(hasDnskey ? 1 : 0, 6); // ANCOUNT (contents are never parsed by checkDnssec)
      qnameAwareServer.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => qnameAwareServer.bind(0, "127.0.0.1", resolve));
    qnameAwarePort = (qnameAwareServer.address() as AddressInfo).port;

    notimpServer = dgram.createSocket("udp4");
    notimpServer.on("message", (msg, rinfo) => {
      const reply = Buffer.from(msg);
      reply[3] = (reply[3]! & 0xf0) | 4; // NOTIMP, regardless of query
      reply.writeUInt16BE(0, 6);
      notimpServer.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => notimpServer.bind(0, "127.0.0.1", resolve));
    notimpPort = (notimpServer.address() as AddressInfo).port;
  });

  afterAll(() => {
    qnameAwareServer.close();
    notimpServer.close();
  });

  it("queries DNSKEY (type 48) and reports true when the resolver answers with records", async () => {
    const result = await udpDnsQuery("127.0.0.1", "hasdnskey.test", 48, qnameAwarePort);
    expect(lastQtype).toBe(48);
    expect(result).toEqual({ rcode: 0, qdcount: 1, ancount: 1 });
    expect(await checkDnssec("hasdnskey.test", [{ server: "127.0.0.1", port: qnameAwarePort }])).toBe(true);
  });

  it("reports false when the resolver answers NOERROR with zero records", async () => {
    expect(await checkDnssec("nodnskey.test", [{ server: "127.0.0.1", port: qnameAwarePort }])).toBe(false);
  });

  it("falls through a NOTIMP resolver to the next one in the list instead of concluding no DNSSEC", async () => {
    const result = await checkDnssec("hasdnskey.test", [
      { server: "127.0.0.1", port: notimpPort },
      { server: "127.0.0.1", port: qnameAwarePort },
    ]);
    expect(result).toBe(true);
  });
});

describe("AXFR zone transfer over TCP (real wire protocol against a fake local nameserver)", () => {
  function dnsHeader(rcode: number, ancount: number): Buffer {
    const h = Buffer.alloc(12);
    h[3] = rcode & 0x0f;
    h.writeUInt16BE(1, 4); // QDCOUNT
    h.writeUInt16BE(ancount, 6);
    return h;
  }

  function encodeName(name: string): Buffer {
    const parts: Buffer[] = [];
    for (const label of name.split(".")) {
      const bytes = Buffer.from(label, "utf-8");
      parts.push(Buffer.from([bytes.length]), bytes);
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
  }

  function encodeQuestion(name: string, qtype: number): Buffer {
    const qtypeBuf = Buffer.alloc(2);
    qtypeBuf.writeUInt16BE(qtype, 0);
    return Buffer.concat([encodeName(name), qtypeBuf, Buffer.from([0, 1])]);
  }

  function encodeRR(name: string, type: number): Buffer {
    const rest = Buffer.alloc(10); // TYPE(2) CLASS(2) TTL(4) RDLENGTH(2) — all zero, no RDATA
    rest.writeUInt16BE(type, 0);
    rest.writeUInt16BE(1, 2);
    return Buffer.concat([encodeName(name), rest]);
  }

  function framedMessage(msg: Buffer): Buffer {
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(msg.length, 0);
    return Buffer.concat([prefix, msg]);
  }

  it("parses a real hand-built AXFR response stream into deduped owner names", () => {
    const msg1 = Buffer.concat([
      dnsHeader(0, 2),
      encodeQuestion("zonetest.invalid", 252),
      encodeRR("zonetest.invalid", 6), // SOA
      encodeRR("www.zonetest.invalid", 1), // A
    ]);
    const msg2 = Buffer.concat([
      dnsHeader(0, 2),
      encodeQuestion("zonetest.invalid", 252),
      encodeRR("mail.zonetest.invalid", 15), // MX
      encodeRR("zonetest.invalid", 6), // SOA (closing)
    ]);
    const stream = Buffer.concat([framedMessage(msg1), framedMessage(msg2)]);

    const names = parseAxfrStream(stream);
    expect(names).toBeDefined();
    expect([...names!].sort()).toEqual(["mail.zonetest.invalid", "www.zonetest.invalid", "zonetest.invalid"]);
  });

  it("reports undefined for an empty (refused) response", () => {
    expect(parseAxfrStream(Buffer.alloc(0))).toBeUndefined();
  });

  it("performs a real AXFR-over-TCP exchange against a fake nameserver and confirms the leak", async () => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return;

        const reply = Buffer.concat([
          dnsHeader(0, 2),
          encodeQuestion("axfrtest.invalid", 252),
          encodeRR("axfrtest.invalid", 6),
          encodeRR("internal.axfrtest.invalid", 1),
        ]);
        socket.end(framedMessage(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const names = await attemptZoneTransferAgainst("127.0.0.1", "axfrtest.invalid", port);
      expect(names).toBeDefined();
      expect([...names!].sort()).toEqual(["axfrtest.invalid", "internal.axfrtest.invalid"]);
    } finally {
      server.close();
    }
  });

  it("returns undefined when the nameserver closes the connection immediately (refusal)", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const names = await attemptZoneTransferAgainst("127.0.0.1", "refused.invalid", port);
      expect(names).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
