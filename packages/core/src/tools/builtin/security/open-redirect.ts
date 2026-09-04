import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's open_redirect.py, scoped to the query parameters
// already present on the given URL — cyberlens's own version also tests
// parameters found by its crawler/discovery scanners across a whole site;
// this project has no crawler yet, so it only has the one URL's own query
// string to work with (get_testable_params, in cyberlens's
// core/candidates.py, reduces to exactly this for a single non-crawled
// page anyway).
//
// A finding is only raised when the server actually answers with a 3xx
// redirect whose Location header points at the exact canary host — never
// merely because the payload is reflected in the response body, which
// would be a much noisier, lower-confidence signal.
const MAX_CANDIDATES = 15;
const CANARY_HOST = "finanfa-redirect-canary.invalid";
const PAYLOADS = [`https://${CANARY_HOST}/`, `//${CANARY_HOST}/`];
const REDIRECT_PARAM_NAME_PATTERN =
  /url|uri|link|redirect|redir|return|returnurl|return_url|next|continue|dest|destination|target|goto|out|forward|callback|checkout_url|success_url/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function redirectsToCanary(location: string): boolean {
  if (!location) return false;
  const normalized = location.startsWith("//") ? `https:${location}` : location;
  try {
    return new URL(normalized).hostname.toLowerCase() === CANARY_HOST;
  } catch {
    return false;
  }
}

function selectRedirectParams(target: URL): string[] {
  const selected: string[] = [];
  for (const [name, value] of target.searchParams.entries()) {
    if (REDIRECT_PARAM_NAME_PATTERN.test(name)) {
      selected.push(name);
    } else if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/")) {
      selected.push(name);
    }
  }
  return [...new Set(selected)];
}

function injectParam(base: URL, paramName: string, payload: string): string {
  const url = new URL(base.toString());
  url.searchParams.set(paramName, payload);
  return url.toString();
}

async function testParam(target: URL, paramName: string): Promise<Finding | undefined> {
  for (const payload of PAYLOADS) {
    const url = injectParam(target, paramName, payload);
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch {
      continue;
    }
    if (!REDIRECT_STATUSES.has(response.status)) continue;

    const location = response.headers.get("location") ?? "";
    if (redirectsToCanary(location)) {
      const score = 6.1;
      const digest = createHash("sha1").update(`${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
      return {
        id: `open-redirect-${digest}`,
        title: `Open Redirect via '${paramName}'`,
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N",
        cvssScore: score,
        cwe: "CWE-601",
        description: `Setting '${paramName}' to an external URL causes the server to issue a redirect there instead of validating the destination stays on-site.`,
        evidence: `GET ${url} -> Location: ${location}`,
        impact:
          "An attacker can craft a link that appears to point at this trusted domain but actually forwards the victim to an attacker-controlled site — commonly used for phishing, OAuth token theft via a manipulated redirect_uri, or to lend credibility to a malicious download.",
        remediation:
          "Validate redirect destinations against an allow-list of known-safe, same-origin paths instead of forwarding to any URL supplied in a parameter. If external redirects are required, use an indirection token mapped server-side to the real destination rather than accepting a raw URL.",
        affectedEndpoint: url,
      };
    }
  }
  return undefined;
}

async function scanOpenRedirect(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const candidates = selectRedirectParams(target).slice(0, MAX_CANDIDATES);

  for (const paramName of candidates) {
    const found = await testParam(target, paramName);
    if (found) findings.push(found);
  }

  if (candidates.length === 0) {
    passed.push({
      label: "No redirect-driving parameters found",
      detail: "No query parameter on the given URL looked like it drives a server-side redirect, by name or by its current value.",
    });
  } else if (findings.length === 0) {
    passed.push({
      label: "No open redirect detected",
      detail: `Tested ${candidates.length} redirect-driving parameter(s) with an external canary URL; none of the responses redirected there.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanOpenRedirectInput {
  url: string;
}

export const securityScanOpenRedirectTool: ToolDefinition<SecurityScanOpenRedirectInput> = {
  name: "security_scan_open_redirect",
  description:
    "Security tool. Tests query parameters on a URL (ones named like a redirect target, or whose value is " +
    "already a URL/path) for open-redirect behavior — injects an external canary URL and only flags it when " +
    "the server actually issues a 3xx redirect there (not merely reflecting the payload in the body). GET-only, " +
    "safe to run. A port of the user's own cyberlens scanner's open_redirect check, scoped to the given URL's " +
    "own query string (no site crawler exists in this project to discover more). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test, e.g. https://example.com/go?next=/home" } },
    required: ["url"],
  },
  describeCall: (input) => `test for open redirect: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanOpenRedirect(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
