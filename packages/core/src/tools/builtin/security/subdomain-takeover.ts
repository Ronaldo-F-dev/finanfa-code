import { resolveCname } from "node:dns/promises";
import type { ToolDefinition } from "../../../core/types.js";
import { scoreFromVector, severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Direct port of cyberlens's subdomain_takeover.py — same wordlist and
// takeover fingerprints. Node's built-in dns/promises.resolveCname
// replaces dnspython; no new dependency needed.
const SUBDOMAIN_WORDLIST = ["www", "mail", "ftp", "admin", "api", "dev", "staging", "test", "blog", "shop", "cdn", "static", "app", "portal", "help", "support", "docs"];

export interface TakeoverFingerprint {
  provider: string;
  cnameSubstring: string;
  signature: string;
}

const TAKEOVER_FINGERPRINTS: TakeoverFingerprint[] = [
  { provider: "GitHub Pages", cnameSubstring: "github.io", signature: "There isn't a GitHub Pages site here" },
  { provider: "Heroku", cnameSubstring: "herokuapp.com", signature: "No such app" },
  { provider: "Heroku", cnameSubstring: "herokudns.com", signature: "No such app" },
  { provider: "AWS S3", cnameSubstring: "s3.amazonaws.com", signature: "NoSuchBucket" },
  { provider: "AWS S3", cnameSubstring: "s3-website", signature: "NoSuchBucket" },
  { provider: "Shopify", cnameSubstring: "myshopify.com", signature: "Sorry, this shop is currently unavailable" },
  { provider: "Fastly", cnameSubstring: "fastly.net", signature: "Fastly error: unknown domain" },
  { provider: "Microsoft Azure", cnameSubstring: "azurewebsites.net", signature: "404 Web Site not found" },
];

const VECTOR = "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N";
const DNS_TIMEOUT_MS = 3_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
  return Promise.race([promise, timeout]);
}

async function resolveCnameQuiet(fqdn: string): Promise<string | undefined> {
  try {
    const answers = await withTimeout(resolveCname(fqdn), DNS_TIMEOUT_MS);
    return answers[0]?.replace(/\.$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** Exported for direct testing against a real unclaimed provider page, without needing to control real DNS to exercise the discovery loop end-to-end. */
export async function confirmTakeover(fqdn: string, cname: string, fp: TakeoverFingerprint): Promise<Finding | undefined> {
  let body: string | undefined;
  for (const scheme of ["https", "http"]) {
    try {
      const response = await fetch(`${scheme}://${fqdn}/`, { signal: AbortSignal.timeout(10_000) });
      body = await response.text();
      break;
    } catch {
      continue;
    }
  }

  if (body === undefined || !body.includes(fp.signature)) return undefined;

  const score = scoreFromVector(VECTOR);
  return {
    id: `subdomain-takeover-${fqdn}`,
    title: `Subdomain Takeover via '${fqdn}' (${fp.provider})`,
    severity: severityFromScore(score),
    cvssVector: VECTOR,
    cvssScore: score,
    cwe: "CWE-350",
    description: `'${fqdn}' has a CNAME record pointing at ${cname} (${fp.provider}), and requesting it returns ${fp.provider}'s unclaimed-resource error page — the corresponding resource has been deleted or was never claimed, but the DNS record still points at it.`,
    evidence: `GET https://${fqdn}/ -> response contains ${fp.provider}'s signature '${fp.signature}'.`,
    impact: `Anyone can register the same resource on ${fp.provider} and immediately serve arbitrary content from '${fqdn}' — a subdomain of a domain your organization is trusted for, usable for phishing, session/cookie theft against any cookie scoped to the parent domain, or bypassing origin checks that trust the whole domain.`,
    remediation: `Remove the dangling CNAME record for '${fqdn}' if the ${fp.provider} resource is no longer in use, or re-claim/re-provision it if it's still needed.`,
    affectedEndpoint: fqdn,
  };
}

async function scanSubdomainTakeover(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }
  if (!hostname) throw new Error(`"${targetUrl}" has no hostname.`);

  const danglingLooking: string[] = [];
  for (const sub of SUBDOMAIN_WORDLIST) {
    const fqdn = `${sub}.${hostname}`;
    const cname = await resolveCnameQuiet(fqdn);
    if (!cname) continue;

    const fp = TAKEOVER_FINGERPRINTS.find((f) => cname.includes(f.cnameSubstring));
    if (!fp) continue;
    danglingLooking.push(fqdn);

    const found = await confirmTakeover(fqdn, cname, fp);
    if (found) findings.push(found);
  }

  if (danglingLooking.length === 0) {
    passed.push({
      label: "No dangling third-party subdomains found",
      detail: "None of the common subdomains checked have a CNAME pointing at a known third-party hosting service.",
    });
  } else if (findings.length === 0) {
    passed.push({
      label: "No subdomain takeover confirmed",
      detail: `${danglingLooking.length} subdomain(s) point at a third-party service via CNAME, but none served that provider's unclaimed-resource error page — they appear to be actively claimed.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanSubdomainTakeoverInput {
  url: string;
}

export const securityScanSubdomainTakeoverTool: ToolDefinition<SecurityScanSubdomainTakeoverInput> = {
  name: "security_scan_subdomain_takeover",
  description:
    "Security tool. Checks common subdomains (www, mail, api, dev, staging, blog, cdn, ...) of a target domain " +
    "for a dangling CNAME pointing at a well-known third-party host (GitHub Pages, Heroku, AWS S3, Shopify, " +
    "Fastly, Azure) whose resource was deleted/never claimed — confirmed by matching that provider's exact " +
    "unclaimed-resource error page, not merely the CNAME existing. Read-only (DNS lookups + a GET per " +
    "candidate). A faithful port of the user's own cyberlens scanner's subdomain_takeover check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com — its hostname's subdomains are checked" } },
    required: ["url"],
  },
  describeCall: (input) => `check subdomain takeover: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanSubdomainTakeover(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
