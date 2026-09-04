import net from "node:net";
import { resolve4, resolve6, resolveMx, resolveNs, resolveTxt } from "node:dns/promises";
import type { ToolDefinition } from "../../../core/types.js";
import { formatScanOutput, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's recon.py — passive-only, no exploit-style payloads,
// just what the target already publishes (DNS, WHOIS, response headers).
// Reports as passed controls (informational context, no "findings" of its
// own — same as the original, which only ever populates
// ctx.tech_fingerprint and passed_controls, never a Finding).
const DNS_TIMEOUT_MS = 5_000;
const WHOIS_PORT = 43;
const WHOIS_TIMEOUT_MS = 10_000;
const MAX_WHOIS_RESPONSE_BYTES = 200_000;
const IANA_WHOIS_HOST = "whois.iana.org";

const REFERRAL_PATTERN = /^\s*(?:whois|refer):\s*(\S+)/im;
const REGISTRAR_WHOIS_SERVER_PATTERN = /^\s*Registrar WHOIS Server:\s*(\S+)/im;
const REGISTRAR_PATTERNS = [/^\s*Registrar Name:\s*(.+)$/im, /^\s*Sponsoring Registrar:\s*(.+)$/im, /^\s*Registrar:\s*(.+)$/im];
const OWNER_PATTERNS = [
  /^\s*Registrant Organization:\s*(.+)$/im,
  /^\s*Registrant Name:\s*(.+)$/im,
  /^\s*Registrant:\s*(.+)$/im,
  /^\s*Organisation:\s*(.+)$/im,
  /^\s*Owner Name:\s*(.+)$/im,
  /^\s*holder-c:\s*(.+)$/im,
];
const EMPTY_VALUE_MARKERS = new Set(["", "n/a", "not disclosed", "redacted for privacy", "data protected", "data redacted"]);

function whoisQuery(host: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: WHOIS_PORT, timeout: WHOIS_TIMEOUT_MS });
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on("connect", () => socket.write(`${query}\r\n`));
    socket.on("data", (chunk) => {
      total += chunk.length;
      if (total <= MAX_WHOIS_RESPONSE_BYTES) chunks.push(chunk);
      else socket.destroy();
    });
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    socket.on("timeout", () => socket.destroy(new Error(`WHOIS query to ${host} timed out`)));
    socket.on("error", reject);
  });
}

function firstMatch(patterns: RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const value = match[1].trim();
      if (!EMPTY_VALUE_MARKERS.has(value.toLowerCase())) return value;
    }
  }
  return undefined;
}

interface WhoisSummary {
  registrar?: string;
  owner?: string;
}

/** Best-effort. Never throws for a domain with no WHOIS referral (an unsupported/unknown TLD) — returns an empty summary instead, a normal outcome, not an error. */
async function lookupDomain(domain: string): Promise<WhoisSummary> {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  const tld = normalized.split(".").at(-1) ?? normalized;

  let ianaResponse: string;
  try {
    ianaResponse = await whoisQuery(IANA_WHOIS_HOST, tld);
  } catch {
    return {};
  }
  const referralMatch = REFERRAL_PATTERN.exec(ianaResponse);
  if (!referralMatch) return {};

  const registryHost = referralMatch[1];
  let registryResponse: string;
  try {
    registryResponse = await whoisQuery(registryHost, normalized);
  } catch {
    return {};
  }

  let fullResponse = registryResponse;
  const serverMatch = REGISTRAR_WHOIS_SERVER_PATTERN.exec(registryResponse);
  if (serverMatch && serverMatch[1].toLowerCase() !== registryHost.toLowerCase()) {
    try {
      const registrarResponse = await whoisQuery(serverMatch[1], normalized);
      fullResponse = `${registrarResponse}\n${registryResponse}`;
    } catch {
      // A thin-registry referral failing shouldn't lose what we already have.
    }
  }

  return { registrar: firstMatch(REGISTRAR_PATTERNS, fullResponse), owner: firstMatch(OWNER_PATTERNS, fullResponse) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
  return Promise.race([promise, timeout]);
}

async function resolveDnsRecords(hostname: string): Promise<Record<string, string[]>> {
  const records: Record<string, string[]> = {};
  const lookups: [string, () => Promise<string[]>][] = [
    ["A", () => resolve4(hostname)],
    ["AAAA", () => resolve6(hostname)],
    ["MX", async () => (await resolveMx(hostname)).map((m) => `${m.exchange} (priority ${m.priority})`)],
    ["TXT", async () => (await resolveTxt(hostname)).map((parts) => parts.join(""))],
    ["NS", () => resolveNs(hostname)],
  ];
  for (const [rtype, lookup] of lookups) {
    try {
      const values = await withTimeout(lookup(), DNS_TIMEOUT_MS);
      if (values.length > 0) records[rtype] = values;
    } catch {
      // Not every record type exists for every host — a miss is normal, not an error.
    }
  }
  return records;
}

async function scanRecon(targetUrl: string): Promise<ScanOutput> {
  const passed: PassedControl[] = [];

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }
  if (!hostname) throw new Error(`"${targetUrl}" has no hostname.`);

  const records = await resolveDnsRecords(hostname);
  if (Object.keys(records).length > 0) {
    const summary = Object.entries(records)
      .map(([rtype, values]) => `${rtype}: ${values.join(", ")}`)
      .join("; ");
    passed.push({ label: "DNS resolution", detail: `${hostname} resolves via ${Object.keys(records).join(", ")} records. ${summary}` });
  }

  const whois = await lookupDomain(hostname);
  if (whois.registrar || whois.owner) {
    const parts = [whois.registrar && `registrar: ${whois.registrar}`, whois.owner && `owner: ${whois.owner}`].filter(Boolean);
    passed.push({ label: "WHOIS lookup", detail: `${hostname} — ${parts.join(", ")}.` });
  }

  try {
    const response = await fetch(targetUrl, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const server = response.headers.get("server");
    if (server) passed.push({ label: "Server banner", detail: `Server: ${server}` });
  } catch {
    // Non-fatal — recon already has DNS/WHOIS results either way.
  }

  return { findings: [], passedControls: passed };
}

interface SecurityScanReconInput {
  url: string;
}

export const securityScanReconTool: ToolDefinition<SecurityScanReconInput> = {
  name: "security_scan_recon",
  description:
    "Security tool. Passive reconnaissance on a domain: DNS records (A/AAAA/MX/TXT/NS), resolved IP, WHOIS " +
    "registrar/owner (via a real raw WHOIS protocol client, RFC 3912 — no bundled dependency, same as " +
    "cyberlens's own implementation), and the HTTP Server response header. Never sends exploit-style payloads " +
    "— purely reads what the target already publishes. Informational only (no vulnerability findings). A " +
    "faithful port of the user's own cyberlens scanner's recon check.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `recon: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanRecon(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
