import http from "node:http";
import https from "node:https";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Direct port of cyberlens's host_header_injection.py. Uses node:http/https
// directly rather than fetch() — undici's fetch silently ignores an
// explicit Host header override (a forbidden header, same as a browser),
// while connecting via the low-level http module and setting the request
// option's `headers.Host` really does send the overridden value, which is
// exactly the "does the server trust an arbitrary Host header" behavior
// this check needs to send in the first place.
const CANARY_HOST = "finanfa-host-header-canary.invalid";
const REQUEST_TIMEOUT_MS = 10_000;

interface RawResponse {
  body: string;
  location: string;
}

function fetchWithHostOverride(target: URL): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { Host: CANARY_HOST },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ body, location: res.headers.location ?? "" }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function scanHostHeaderInjection(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  let response: RawResponse;
  try {
    response = await fetchWithHostOverride(target);
  } catch (err) {
    throw new Error(`Could not reach ${targetUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const reflectedInBody = response.body.includes(CANARY_HOST);
  const reflectedInLocation = response.location.includes(CANARY_HOST);

  if (!reflectedInBody && !reflectedInLocation) {
    return {
      findings,
      passedControls: [{ label: "Host header not trusted", detail: "An arbitrary Host header value was not reflected in the response body or a redirect Location header." }],
    };
  }

  const where = reflectedInLocation ? "Location header" : "response body";
  const score = 6.5;
  findings.push({
    id: "host-header-injection",
    title: "Host Header Injection",
    severity: severityFromScore(score),
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N",
    cvssScore: score,
    cwe: "CWE-644",
    description: `An arbitrary \`Host\` header value is trusted and reflected in the ${where} instead of being validated against the server's configured hostname(s).`,
    evidence: `GET ${targetUrl} with Host: ${CANARY_HOST} -> value reflected in ${where}.`,
    impact:
      "Content built from the Host header (password-reset links, canonical URLs, cache keys) can be poisoned with an attacker-chosen domain — commonly exploited to redirect password-reset emails to an attacker-controlled site, or, where a shared cache keys on the response without the Host header, to serve the poisoned response to other users entirely.",
    remediation:
      "Validate the Host header against an explicit allow-list of expected hostnames at the application or reverse-proxy layer, and build absolute URLs (password resets, canonical links) from a fixed, configured base URL rather than the incoming request's Host header.",
    affectedEndpoint: targetUrl,
  });

  return { findings, passedControls: [] };
}

interface SecurityScanHostHeaderInjectionInput {
  url: string;
}

export const securityScanHostHeaderInjectionTool: ToolDefinition<SecurityScanHostHeaderInjectionInput> = {
  name: "security_scan_host_header_injection",
  description:
    "Security tool. Sends a request to a URL with the Host header replaced by a fixed canary value, and checks " +
    "whether that value comes back unescaped in the response body or a Location header — confirming the server " +
    "trusts an arbitrary Host header instead of validating it (used to poison password-reset links, canonical " +
    "URLs, or cache keys). A single GET, no state change. A faithful port of the user's own cyberlens " +
    "scanner's host_header_injection check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `test host header injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanHostHeaderInjection(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
