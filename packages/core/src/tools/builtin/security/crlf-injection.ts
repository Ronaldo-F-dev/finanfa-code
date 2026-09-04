import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's crlf_injection.py, scoped to the given URL's own
// query parameters (see open-redirect.ts for why — no crawler here).
//
// Injects a percent-encoded \r\n sequence followed by a marker header into
// every query parameter, and confirms exploitation only if that marker
// actually comes back as a DISTINCT HTTP response header — i.e. the server
// decoded the encoded CRLF and spliced it into the raw response headers.
// Deliberately doesn't attempt a full response-splitting PoC (a second CRLF
// pair forging a whole body) — confirming header injection alone is
// already unambiguous evidence of the same root cause (CWE-113).
const MAX_CANDIDATES = 15;
const MARKER_HEADER = "x-finanfa-crlf-marker";
const MARKER_VALUE = "injected";
const PAYLOAD = `finanfa%0d%0a${MARKER_HEADER}:%20${MARKER_VALUE}`;

function injectRawParam(target: URL, name: string, rawPayload: string): string {
  // Inserts rawPayload verbatim rather than through URLSearchParams.set,
  // which would re-percent-encode the literal '%' characters the CRLF
  // payload is already correctly encoded with.
  const params = new URLSearchParams(target.search);
  params.delete(name);
  const otherQuery = params.toString();
  const injected = `${name}=${rawPayload}`;
  const newQuery = otherQuery ? `${otherQuery}&${injected}` : injected;
  return `${target.origin}${target.pathname}?${newQuery}${target.hash}`;
}

async function testParam(target: URL, paramName: string): Promise<Finding | undefined> {
  const url = injectRawParam(target, paramName, PAYLOAD);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    return undefined;
  }

  const value = response.headers.get(MARKER_HEADER);
  if (!value?.includes(MARKER_VALUE)) return undefined;

  const score = 6.5;
  const digest = createHash("sha1").update(`${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
  return {
    id: `crlf-injection-${digest}`,
    title: `CRLF Injection via '${paramName}'`,
    severity: severityFromScore(score),
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
    cvssScore: score,
    cwe: "CWE-113",
    description: `Injecting an encoded CRLF sequence into '${paramName}' causes the server to decode it and splice an attacker-chosen header into the raw HTTP response, instead of treating the whole value as inert query-string data.`,
    evidence: `GET ${url} -> response includes header '${MARKER_HEADER}: ${MARKER_VALUE}', not present on an unmodified request.`,
    impact:
      "An attacker who controls part of the raw HTTP response can set arbitrary response headers (e.g. forge Set-Cookie, cache-control, or CORS headers) and, chained with a second CRLF pair, split the response into two — enabling HTTP response splitting and cache poisoning against any shared cache/proxy in front of the application.",
    remediation:
      "Strip or reject CR (%0D) and LF (%0A) characters from any user input used to construct a response header or redirect target. Most modern web frameworks do this by default — if this fired, a custom header-construction path is likely bypassing that protection.",
    affectedEndpoint: target.toString(),
  };
}

async function scanCrlfInjection(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const candidates = [...new Set([...target.searchParams.keys()])].slice(0, MAX_CANDIDATES);

  for (const paramName of candidates) {
    const found = await testParam(target, paramName);
    if (found) findings.push(found);
  }

  if (candidates.length === 0) {
    passed.push({ label: "No injectable parameters found", detail: "No query parameters were found on the given URL to test for CRLF injection." });
  } else if (findings.length === 0) {
    passed.push({
      label: "No CRLF injection detected",
      detail: `Tested ${candidates.length} GET parameter(s) with an encoded CRLF + marker-header payload; none caused the marker to appear as a distinct response header.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanCrlfInjectionInput {
  url: string;
}

export const securityScanCrlfInjectionTool: ToolDefinition<SecurityScanCrlfInjectionInput> = {
  name: "security_scan_crlf_injection",
  description:
    "Security tool. Tests a URL's query parameters for CRLF injection / HTTP response splitting — injects an " +
    "encoded CRLF sequence plus a marker header name into each parameter, and only flags a parameter when the " +
    "marker actually comes back as a distinct HTTP response header (unambiguous evidence, not a heuristic). " +
    "GET-only, safe to run. A port of the user's own cyberlens scanner's crlf_injection check, scoped to the " +
    "given URL's own query string. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for CRLF injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanCrlfInjection(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
