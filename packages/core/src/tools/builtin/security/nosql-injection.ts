import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's nosql_injection.py — same two techniques as sqli.ts
// (error-based + boolean-blind), MongoDB-flavored operator-injection
// payloads/error signatures instead of SQL syntax. GET-only, scoped to
// the given URL's own query parameters (see sqli.ts for why). riskLevel
// "dangerous" — sends real operator-injection payloads to a live target.
const MAX_CANDIDATES = 15;
const LENGTH_TOLERANCE_BYTES = 40;
const ERROR_PAYLOAD = "'||'1'=='1";
const BOOLEAN_TRUE = "' || '1'=='1";
const BOOLEAN_FALSE = "' || '1'=='2";
const BENIGN_VALUE = "1";

const NOSQL_ERROR_SIGNATURES = [/MongoError/i, /MongoServerError/i, /BSONError/i, /E11000 duplicate key/i, /CastError/i, /ValidationError.*mongoose/i];

interface ProbeResponse {
  status: number;
  length: number;
}

function looksBooleanInjectable(baseline: ProbeResponse, trueResp: ProbeResponse, falseResp: ProbeResponse): boolean {
  if (trueResp.status !== falseResp.status) return true;
  if (Math.abs(trueResp.length - falseResp.length) <= LENGTH_TOLERANCE_BYTES) return false;
  return Math.abs(trueResp.length - baseline.length) < Math.abs(falseResp.length - baseline.length);
}

async function probe(target: URL, paramName: string): Promise<Finding | undefined> {
  const fetchWith = async (payload: string): Promise<{ status: number; length: number; text: string }> => {
    const url = new URL(target.toString());
    url.searchParams.set(paramName, payload);
    const response = await fetch(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    return { status: response.status, length: text.length, text };
  };

  const location = (() => {
    const u = new URL(target.toString());
    u.searchParams.set(paramName, "<payload>");
    return u.toString();
  })();
  const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);

  let baseline: { status: number; length: number; text: string };
  try {
    baseline = await fetchWith(BENIGN_VALUE);
  } catch {
    return undefined;
  }

  try {
    const errorResponse = await fetchWith(ERROR_PAYLOAD);
    for (const pattern of NOSQL_ERROR_SIGNATURES) {
      const match = pattern.exec(errorResponse.text);
      if (match) {
        const score = 9.8;
        return {
          id: `nosql-error-based-${digest}`,
          title: `NoSQL Injection (Error-Based) in '${paramName}'`,
          severity: severityFromScore(score),
          cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
          cvssScore: score,
          cwe: "CWE-943",
          description: `Injecting a NoSQL operator payload into '${paramName}' triggers a database error reflected in the response, confirming the input reaches a NoSQL query unsanitized.`,
          evidence: `GET ${location} with payload ${JSON.stringify(ERROR_PAYLOAD)} -> database error signature matched: ${JSON.stringify(match[0])}`,
          impact: "An attacker can manipulate the query logic to bypass authentication or read/modify data outside intended access, via operator injection ($ne, $gt, $where, etc.).",
          remediation: "Use a query builder/ODM that treats input as data, never as an operator; explicitly reject non-scalar (object/array) input for fields that should only ever be strings/numbers.",
          affectedEndpoint: location,
        };
      }
    }
  } catch {
    // Non-fatal — falls through to the boolean-based check below.
  }

  let trueResp: { status: number; length: number };
  let falseResp: { status: number; length: number };
  try {
    trueResp = await fetchWith(BOOLEAN_TRUE);
    falseResp = await fetchWith(BOOLEAN_FALSE);
  } catch {
    return undefined;
  }

  if (looksBooleanInjectable(baseline, trueResp, falseResp)) {
    const score = 7.5;
    return {
      id: `nosql-boolean-blind-${digest}`,
      title: `Possible Blind NoSQL Injection in '${paramName}' (Needs Manual Verification)`,
      severity: severityFromScore(score),
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cvssScore: score,
      cwe: "CWE-943",
      description: `Injecting always-true vs. always-false NoSQL operator conditions into '${paramName}' produces meaningfully different responses — a heuristic signal of blind NoSQL injection, not a certainty.`,
      evidence: `GET ${location}: true-condition (${JSON.stringify(BOOLEAN_TRUE)}) and false-condition (${JSON.stringify(BOOLEAN_FALSE)}) payloads produced different response sizes/status codes.`,
      impact: "If confirmed, an attacker can extract data or bypass authentication via blind NoSQL operator injection even without visible error messages.",
      remediation: "Use a query builder/ODM that treats input as data, never as an operator. Manually verify this finding — boolean-based heuristics can false-positive on naturally dynamic pages.",
      affectedEndpoint: location,
    };
  }

  return undefined;
}

async function scanNosqlInjection(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const candidates = [...new Set(target.searchParams.keys())].slice(0, MAX_CANDIDATES);

  for (const paramName of candidates) {
    const found = await probe(target, paramName);
    if (found) findings.push(found);
  }

  if (candidates.length === 0) {
    passed.push({ label: "No injectable parameters found", detail: "No query parameters were found on the given URL (POST forms aren't tested — no form discovery in this project)." });
  } else if (findings.length === 0) {
    passed.push({
      label: "No NoSQL injection detected",
      detail: `Tested ${candidates.length} GET parameter(s) with NoSQL operator-injection payloads; none indicated injection.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanNosqlInjectionInput {
  url: string;
}

export const securityScanNosqlInjectionTool: ToolDefinition<SecurityScanNosqlInjectionInput> = {
  name: "security_scan_nosql_injection",
  description:
    "Security tool. Tests a URL's query parameters for NoSQL injection (MongoDB-flavored): error-based (an " +
    "operator-injection payload triggers a database error signature — high confidence) and boolean-based blind " +
    "(always-true vs always-false operator conditions produce meaningfully different responses — heuristic). " +
    "Sends real operator-injection payloads to a live target. GET-only. A port of the user's own cyberlens " +
    "scanner's nosql_injection check. " +
    "IMPORTANT: only test a target you own or have explicit, documented authorization to test — this sends " +
    "real exploit-style payloads, unlike the passive/recon security_scan_* tools.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for NoSQL injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanNosqlInjection(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
