import { resolve4, resolveNs, getServers } from "node:dns/promises";
import dgram from "node:dgram";
import net from "node:net";
import { randomInt } from "node:crypto";
import { severityFromScore, scoreFromVector } from "./cvss.js";
import type { ToolDefinition } from "../../../core/types.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Full port of cyberlens's dns_hardening.py. Subdomain enumeration uses
// Node's built-in resolver as before. DNSSEC (DNSKEY) and zone-transfer
// (AXFR) need query/record types Node's built-in `dns` module doesn't
// expose (its resolve() rrtypes are A/AAAA/ANY/CAA/CNAME/MX/NAPTR/NS/PTR/
// SOA/SRV/TXT — no DNSKEY, and no raw AXFR-over-TCP) — both are now
// implemented directly against the DNS wire format (RFC 1035) over
// node:dgram (UDP, for the DNSKEY query) and node:net (TCP, for AXFR),
// the same "well-defined protocol, no dependency needed" approach as this
// project's own WHOIS/MySQL/Postgres ports.
const SUBDOMAIN_WORDLIST = ["www", "mail", "ftp", "admin", "api", "dev", "staging", "test", "vpn", "webmail", "ns1", "ns2", "smtp", "blog", "cdn"];
const DNS_TIMEOUT_MS = 3_000;
const DNSSEC_VECTOR = "AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N";
const ZONE_TRANSFER_VECTOR = "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N";
const DNSKEY_TYPE = 48;
const AXFR_TYPE = 252;
const CLASS_IN = 1;

function encodeDnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf-8");
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildDnsQuery(qname: string, qtype: number, recursionDesired: boolean): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(randomInt(0x10000), 0);
  header.writeUInt16BE(recursionDesired ? 0x0100 : 0x0000, 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const qtypeBuf = Buffer.alloc(2);
  qtypeBuf.writeUInt16BE(qtype, 0);
  const qclassBuf = Buffer.alloc(2);
  qclassBuf.writeUInt16BE(CLASS_IN, 0);
  return Buffer.concat([header, encodeDnsName(qname), qtypeBuf, qclassBuf]);
}

/** Parses a (possibly compressed, RFC 1035 §4.1.4) name starting at `offset` within `msg`. Returns the name and the offset immediately after it in the ORIGINAL (uncompressed-position) stream. */
function parseDnsName(msg: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  while (pos < msg.length) {
    const len = msg[pos]!;
    if (len === 0) {
      pos += 1;
      if (next === -1) next = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (jumps++ > 20) throw new Error("DNS name compression pointer loop");
      const pointer = ((len & 0x3f) << 8) | msg[pos + 1]!;
      if (next === -1) next = pos + 2;
      pos = pointer;
      continue;
    }
    labels.push(msg.subarray(pos + 1, pos + 1 + len).toString("utf-8"));
    pos += 1 + len;
  }
  return { name: labels.join("."), next: next === -1 ? pos : next };
}

interface ParsedRR {
  name: string;
  type: number;
  next: number;
}

function parseResourceRecord(msg: Buffer, offset: number): ParsedRR {
  const { name, next } = parseDnsName(msg, offset);
  const type = msg.readUInt16BE(next);
  const rdlength = msg.readUInt16BE(next + 8);
  return { name, type, next: next + 10 + rdlength };
}

function parseDnsHeader(msg: Buffer): { rcode: number; qdcount: number; ancount: number } {
  return { rcode: msg[3]! & 0x0f, qdcount: msg.readUInt16BE(4), ancount: msg.readUInt16BE(6) };
}

export async function udpDnsQuery(
  server: string,
  qname: string,
  qtype: number,
  port = 53,
  timeoutMs = 5_000,
): Promise<{ rcode: number; ancount: number } | undefined> {
  const socket = dgram.createSocket("udp4");
  const query = buildDnsQuery(qname, qtype, true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: { rcode: number; ancount: number } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.on("error", () => finish(undefined));
    socket.on("message", (msg) => {
      try {
        finish(parseDnsHeader(msg));
      } catch {
        finish(undefined);
      }
    });
    socket.send(query, port, server, (err) => {
      if (err) finish(undefined);
    });
  });
}

const NOTIMP = 4;
// Prefer public recursive resolvers over the system's configured one: a
// local stub resolver (e.g. systemd-resolved's 127.0.0.53) commonly
// implements only a curated set of RR types and answers DNSKEY queries
// with NOTIMP regardless of whether the domain actually has DNSSEC —
// confirmed against this sandbox's own resolver while building this
// check. Only fall through to the system resolver as a last resort.
export async function checkDnssec(hostname: string, resolvers?: { server: string; port?: number }[]): Promise<boolean> {
  const list = resolvers ?? [{ server: "1.1.1.1" }, { server: "8.8.8.8" }, ...getServers().map((server) => ({ server }))];
  for (const { server, port } of list) {
    const result = await udpDnsQuery(server, hostname, DNSKEY_TYPE, port ?? 53);
    if (result === undefined) continue; // network error/timeout — try the next resolver
    if (result.rcode === NOTIMP) continue; // this resolver refuses the query type — try the next resolver
    return result.rcode === 0 && result.ancount > 0;
  }
  return false;
}

/** Reads every length-prefixed DNS message from a TCP AXFR response until the connection closes, returning the deduped set of owner names seen across all answer records — or undefined if nothing useful came back (refused/closed with no data, or unparseable). */
export function parseAxfrStream(all: Buffer): Set<string> | undefined {
  const names = new Set<string>();
  let offset = 0;
  let sawAnyMessage = false;

  while (offset + 2 <= all.length) {
    const len = all.readUInt16BE(offset);
    offset += 2;
    if (offset + len > all.length) break;
    const msg = all.subarray(offset, offset + len);
    offset += len;
    sawAnyMessage = true;

    const { rcode, qdcount, ancount } = parseDnsHeader(msg);
    if (rcode !== 0) continue;

    let pos = 12;
    for (let i = 0; i < qdcount; i++) {
      const { next } = parseDnsName(msg, pos);
      pos = next + 4; // QTYPE + QCLASS
    }
    for (let i = 0; i < ancount; i++) {
      const rr = parseResourceRecord(msg, pos);
      pos = rr.next;
      const normalized = rr.name.replace(/\.$/, "").toLowerCase();
      if (normalized) names.add(normalized);
    }
  }

  return sawAnyMessage && names.size > 0 ? names : undefined;
}

export async function attemptZoneTransferAgainst(nsIp: string, hostname: string, port = 53, timeoutMs = 8_000): Promise<Set<string> | undefined> {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: nsIp, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: Set<string> | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    socket.on("connect", () => {
      const query = buildDnsQuery(hostname, AXFR_TYPE, false);
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([prefix, query]));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => finish(undefined));
    socket.on("close", () => {
      if (settled) return;
      try {
        finish(parseAxfrStream(Buffer.concat(chunks)));
      } catch {
        finish(undefined);
      }
    });
  });
}

async function attemptZoneTransfer(hostname: string): Promise<string[] | undefined> {
  let nsRecords: string[];
  try {
    nsRecords = await resolveNs(hostname);
  } catch {
    return undefined;
  }

  for (const ns of nsRecords) {
    let ips: string[];
    try {
      ips = await resolve4(ns.replace(/\.$/, ""));
    } catch {
      continue;
    }
    for (const ip of ips) {
      const names = await attemptZoneTransferAgainst(ip, hostname);
      if (names && names.size > 0) return [...names].sort();
    }
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
  return Promise.race([promise, timeout]);
}

async function resolves(fqdn: string): Promise<boolean> {
  try {
    await withTimeout(resolve4(fqdn), DNS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

async function enumerateSubdomains(hostname: string): Promise<string[]> {
  const found: string[] = [];
  for (const sub of SUBDOMAIN_WORDLIST) {
    if (await resolves(`${sub}.${hostname}`)) found.push(sub);
  }
  return found;
}

async function scanDnsHardening(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: ScanOutput["passedControls"] = [];

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }
  if (!hostname) throw new Error(`"${targetUrl}" has no hostname.`);

  if (await checkDnssec(hostname)) {
    passed.push({ label: "DNSSEC", detail: `${hostname} publishes a DNSKEY record set.` });
  } else {
    const score = scoreFromVector(DNSSEC_VECTOR);
    findings.push({
      id: "dns-dnssec-not-enabled",
      title: "DNSSEC Not Enabled",
      severity: severityFromScore(score),
      cvssVector: DNSSEC_VECTOR,
      cvssScore: score,
      cwe: "CWE-345",
      description: `No DNSKEY record set was found for ${hostname}, indicating DNSSEC is not enabled.`,
      evidence: `DNSKEY query for ${hostname} returned no records.`,
      impact: "Without DNSSEC, DNS responses for this domain cannot be cryptographically validated by resolvers, leaving clients open to cache-poisoning/spoofing attacks that redirect them to attacker-controlled infrastructure.",
      remediation: "Enable DNSSEC signing with your DNS provider/registrar and publish a DS record at the parent zone.",
      affectedEndpoint: hostname,
    });
  }

  const leaked = await attemptZoneTransfer(hostname);
  if (leaked) {
    const zoneScore = scoreFromVector(ZONE_TRANSFER_VECTOR);
    findings.push({
      id: "dns-zone-transfer-allowed",
      title: "DNS Zone Transfer (AXFR) Allowed",
      severity: severityFromScore(zoneScore),
      cvssVector: ZONE_TRANSFER_VECTOR,
      cvssScore: zoneScore,
      cwe: "CWE-200",
      description: `A nameserver for ${hostname} answered an unauthenticated AXFR zone transfer request, disclosing ${leaked.length} DNS record(s).`,
      evidence: `AXFR ${hostname} -> ${leaked.slice(0, 15).join(", ")}${leaked.length > 15 ? " ..." : ""}`,
      impact: "A full zone transfer discloses every hostname in the zone (internal systems, staging environments, infrastructure hints) in one request, significantly expanding an attacker's reconnaissance of the organization.",
      remediation: "Restrict AXFR to authorized secondary nameservers only (ACLs/TSIG) and refuse zone transfer requests from arbitrary clients.",
      affectedEndpoint: hostname,
    });
  } else {
    passed.push({ label: "DNS zone transfer", detail: "Nameservers refused AXFR zone transfer requests." });
  }

  const found = await enumerateSubdomains(hostname);
  if (found.length > 0) {
    findings.push({
      id: "dns-subdomains-discovered",
      title: "Additional Subdomains Discovered",
      severity: "INFO",
      description: `${found.length} common subdomain(s) of ${hostname} resolve, expanding the organization's known attack surface beyond the scanned target.`,
      evidence: `Resolved: ${found.map((s) => `${s}.${hostname}`).join(", ")}`,
      impact: "Informational — each resolved subdomain is a separate asset that may warrant its own authorized assessment.",
      affectedEndpoint: hostname,
    });
  } else {
    passed.push({ label: "Subdomain enumeration", detail: "None of the common subdomains checked resolve." });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanDnsHardeningInput {
  url: string;
}

export const securityScanDnsHardeningTool: ToolDefinition<SecurityScanDnsHardeningInput> = {
  name: "security_scan_dns_hardening",
  description:
    "Security tool. Checks whether a domain publishes a DNSKEY record set (DNSSEC), whether its nameservers " +
    "answer an unauthenticated AXFR zone transfer request (disclosing every hostname in the zone), and " +
    "enumerates common subdomains (www, mail, api, dev, staging, vpn, ns1/ns2, ...) that actually resolve. A " +
    "full port of the user's own cyberlens scanner's dns_hardening check, sending raw DNS wire-format queries " +
    "(DNSKEY over UDP, AXFR over TCP) directly since Node's built-in resolver doesn't expose either. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com — its hostname's subdomains are checked" } },
    required: ["url"],
  },
  describeCall: (input) => `enumerate subdomains: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanDnsHardening(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
