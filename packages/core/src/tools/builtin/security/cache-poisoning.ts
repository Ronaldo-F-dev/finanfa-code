import type { ToolDefinition } from "../../../core/types.js";
import { scoreFromVector, severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Direct port of cyberlens's cache_poisoning.py — deliberately heuristic,
// not a confirmed exploit. Actually proving cache poisoning means
// demonstrating a SECOND, unrelated request receives the poisoned
// response back from a shared cache — poisoning a real shared cache is
// the attack itself, not a safe way to test for it. So this only flags
// the two structural preconditions from a single request: an unkeyed
// input (X-Forwarded-Host, the most common unkeyed cache-key gap) is
// reflected, AND the response looks cacheable.
const CANARY_HOST = "finanfa-cache-poison-canary.invalid";
const CACHE_INDICATOR_HEADERS = ["x-cache", "cf-cache-status", "age", "x-varnish", "x-cache-hits"];
const MAX_AGE_PATTERN = /max-age=(\d+)/;
const VECTOR = "AV:N/AC:H/PR:N/UI:R/S:C/C:N/I:H/A:N";

function looksCacheable(headers: Headers): boolean {
  const cacheControl = headers.get("cache-control")?.toLowerCase() ?? "";
  if (cacheControl.includes("no-store") || cacheControl.includes("private") || cacheControl.includes("no-cache")) return false;
  if (CACHE_INDICATOR_HEADERS.some((h) => headers.has(h))) return true;
  if (cacheControl.includes("public")) return true;
  const match = MAX_AGE_PATTERN.exec(cacheControl);
  return Boolean(match && Number(match[1]) > 0);
}

async function scanCachePoisoning(target: string): Promise<ScanOutput> {
  let response: Response;
  try {
    response = await fetch(target, { headers: { "X-Forwarded-Host": CANARY_HOST }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`Could not reach ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await response.text();
  const reflected = body.includes(CANARY_HOST) || (response.headers.get("location") ?? "").includes(CANARY_HOST);

  if (!reflected) {
    return {
      findings: [],
      passedControls: [{ label: "X-Forwarded-Host not reflected", detail: "An arbitrary X-Forwarded-Host header value was not reflected in the response body or a redirect Location header." }],
    };
  }

  const cacheable = looksCacheable(response.headers);
  if (!cacheable) {
    return {
      findings: [],
      passedControls: [
        {
          label: "Reflected header on a non-cacheable response",
          detail: "X-Forwarded-Host is reflected, but the response does not look cacheable (no shared-cache indicator header, and Cache-Control does not permit caching) — a prerequisite for actual cache poisoning impact.",
        },
      ],
    };
  }

  const score = scoreFromVector(VECTOR);
  const cacheControl = response.headers.get("cache-control") ?? "(absent)";
  const indicatorsPresent = CACHE_INDICATOR_HEADERS.filter((h) => response.headers.has(h));
  const finding: Finding = {
    id: "cache-poisoning-unkeyed-x-forwarded-host",
    title: "Potential Web Cache Poisoning via Unkeyed X-Forwarded-Host",
    severity: severityFromScore(score),
    cvssVector: VECTOR,
    cvssScore: score,
    cwe: "CWE-444",
    description:
      "The `X-Forwarded-Host` header is reflected into the response, and the response looks cacheable — the two preconditions for web cache poisoning. This is a heuristic finding: confirming real impact requires manually verifying a shared cache sits in front of this response and does not vary its cache key on this header.",
    evidence: `GET ${target} with X-Forwarded-Host: ${CANARY_HOST} -> value reflected; Cache-Control: ${cacheControl}, cache indicator headers present: ${indicatorsPresent.length > 0 ? indicatorsPresent.join(", ") : "none"}.`,
    impact:
      "If a shared cache in front of this application does not vary its cache key on X-Forwarded-Host, an attacker can poison the cached response for a shared URL — every subsequent visitor served from that cache entry (until it expires) receives the attacker's injected content instead of the real page.",
    remediation:
      "Either strip/ignore X-Forwarded-Host entirely unless explicitly needed, or ensure the cache's key includes it (Vary: X-Forwarded-Host) so a poisoned value can't be served to a different, unrelated request.",
    affectedEndpoint: target,
  };

  return { findings: [finding], passedControls: [] };
}

interface SecurityScanCachePoisoningInput {
  url: string;
}

export const securityScanCachePoisoningTool: ToolDefinition<SecurityScanCachePoisoningInput> = {
  name: "security_scan_cache_poisoning",
  description:
    "Security tool. Checks for the two structural preconditions of web cache poisoning from a single request: " +
    "does the X-Forwarded-Host header get reflected into the response, and does the response look cacheable " +
    "(shared-cache indicator header, or Cache-Control permitting caching)? Deliberately heuristic, not a " +
    "confirmed exploit — actually proving cache poisoning means poisoning a real shared cache, which is the " +
    "attack itself, not a safe test. Reports MEDIUM severity and says plainly that manual confirmation is " +
    "needed. A faithful port of the user's own cyberlens scanner's cache_poisoning check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `check cache poisoning preconditions: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanCachePoisoning(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
