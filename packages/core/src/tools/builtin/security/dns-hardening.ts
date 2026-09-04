import { resolve4 } from "node:dns/promises";
import type { ToolDefinition } from "../../../core/types.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Partial port of cyberlens's dns_hardening.py — subdomain enumeration
// only. Its DNSSEC (DNSKEY record) and zone-transfer (AXFR) checks are
// deliberately NOT ported: both need raw low-level DNS query types
// (DNSKEY, AXFR-over-TCP) that Node's built-in dns module doesn't expose
// (dns.resolve()'s supported rrtypes are A/AAAA/ANY/CAA/CNAME/MX/NAPTR/NS/
// PTR/SOA/SRV/TXT — no DNSKEY), and a hand-rolled DNS wire-format
// implementation was judged too large/fragile a side-quest for this pass.
// Revisit with a real DNS library if those checks are wanted later.
const SUBDOMAIN_WORDLIST = ["www", "mail", "ftp", "admin", "api", "dev", "staging", "test", "vpn", "webmail", "ns1", "ns2", "smtp", "blog", "cdn"];
const DNS_TIMEOUT_MS = 3_000;

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

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }
  if (!hostname) throw new Error(`"${targetUrl}" has no hostname.`);

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
  }

  return { findings, passedControls: found.length === 0 ? [{ label: "Subdomain enumeration", detail: "None of the common subdomains checked resolve." }] : [] };
}

interface SecurityScanDnsHardeningInput {
  url: string;
}

export const securityScanDnsHardeningTool: ToolDefinition<SecurityScanDnsHardeningInput> = {
  name: "security_scan_dns_hardening",
  description:
    "Security tool. Enumerates common subdomains (www, mail, api, dev, staging, vpn, ns1/ns2, ...) of a target " +
    "domain that actually resolve, surfacing attack surface beyond the scanned target itself. Informational " +
    "only. A partial port of the user's own cyberlens scanner's dns_hardening check — its DNSSEC and DNS zone " +
    "transfer (AXFR) checks are NOT included here (they need raw DNS query types Node's built-in resolver " +
    "doesn't support). " +
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
