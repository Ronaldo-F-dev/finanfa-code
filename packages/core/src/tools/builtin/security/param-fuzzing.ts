import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's param_fuzzing.py, GET-only (its POST form fuzzing
// needs discovered forms + --active-forms, neither of which apply here —
// no crawler in this project), scoped to the given URL's own query
// parameters. Distinct from the injection-specific scanners (ssrf/lfi/
// xxe/xss): this sends generically malformed values a well-written
// validator should reject cleanly regardless of what the value is used
// for, and flags only a server CRASH (5xx a benign value didn't trigger)
// — CWE-20, Improper Input Validation, not any one injection class.
const MAX_CANDIDATES = 15;
const BENIGN_VALUE = "1";

const FUZZ_PAYLOADS: [string, string][] = [
  ["empty string", ""],
  ["very long string (5000 chars)", "A".repeat(5000)],
  ["negative number", "-1"],
  ["integer overflow", "9".repeat(30)],
  ["null byte", "test\x00null"],
  ["unicode/control characters", "üñïçödé™<>{}[]%0d%0a"],
];

const STACK_TRACE_MARKERS = [
  /Traceback \(most recent call last\)/,
  /at Object\.<anonymous>/,
  /\.js:\d+:\d+/,
  /Fatal error:/,
  /Exception in thread/,
  /System\.[A-Za-z.]+Exception/,
];

async function probe(target: URL, paramName: string): Promise<Finding | undefined> {
  const fetchWith = (payload: string) => {
    const url = new URL(target.toString());
    url.searchParams.set(paramName, payload);
    return fetch(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) }).then(async (r) => ({ status: r.status, text: await r.text(), url: url.toString() }));
  };

  let baseline: { status: number };
  try {
    baseline = await fetchWith(BENIGN_VALUE);
  } catch {
    return undefined;
  }

  const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);

  for (const [label, payload] of FUZZ_PAYLOADS) {
    let response: { status: number; text: string; url: string };
    try {
      response = await fetchWith(payload);
    } catch {
      continue;
    }

    if (response.status < 500 || baseline.status >= 500) continue;

    let stackTraceMatch: string | undefined;
    for (const pattern of STACK_TRACE_MARKERS) {
      const m = pattern.exec(response.text);
      if (m) {
        stackTraceMatch = m[0];
        break;
      }
    }

    const score = stackTraceMatch ? 6.5 : 5.3;
    return {
      id: `param-fuzzing-server-error-${digest}`,
      title: `Unhandled Server Error on Malformed Input in '${paramName}'`,
      severity: severityFromScore(score),
      cvssVector: stackTraceMatch ? "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:L" : "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L",
      cvssScore: score,
      cwe: "CWE-20",
      description:
        `Sending a ${label} value for '${paramName}' triggers an HTTP ${response.status} server error, where a benign value returns HTTP ${baseline.status}.` +
        (stackTraceMatch ? " A stack trace is disclosed in the response." : ""),
      evidence: `GET ${response.url} with payload (${label}) ${JSON.stringify(payload.slice(0, 80))} -> HTTP ${response.status}` + (stackTraceMatch ? `; matched stack-trace marker: ${JSON.stringify(stackTraceMatch)}` : ""),
      impact:
        "Unhandled exceptions on malformed input indicate missing input validation; at minimum this is a reliability/DoS risk (any client can crash the handler), and a leaked stack trace additionally discloses internal implementation details useful for crafting further attacks.",
      remediation: "Validate and sanitize this input (type, length, range) before use, and ensure the application returns a generic error page instead of a raw stack trace on unexpected exceptions.",
      affectedEndpoint: response.url,
    };
  }

  return undefined;
}

async function scanParamFuzzing(targetUrl: string): Promise<ScanOutput> {
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
    passed.push({ label: "No parameters found to fuzz", detail: "No query parameters were found on the given URL (POST forms aren't tested — no form discovery in this project)." });
  } else if (findings.length === 0) {
    passed.push({
      label: "No input validation issues found",
      detail: `Tested ${candidates.length} GET parameter(s) against ${FUZZ_PAYLOADS.length} boundary/edge-case payloads each; none triggered a server error.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanParamFuzzingInput {
  url: string;
}

export const securityScanParamFuzzingTool: ToolDefinition<SecurityScanParamFuzzingInput> = {
  name: "security_scan_param_fuzzing",
  description:
    "Security tool. Sends generically malformed values (empty, 5000-char string, negative number, integer " +
    "overflow, null byte, unicode/control characters) into a URL's query parameters — not injection payloads, " +
    "just boundary/edge cases a well-written validator should reject cleanly. Flags only a server CRASH (5xx a " +
    "benign value didn't trigger), especially with a leaked stack trace. GET-only. CWE-20 (Improper Input " +
    "Validation), distinct from the injection-specific tools (ssrf/lfi/xxe/xss/sqli/...). A port of the user's " +
    "own cyberlens scanner's param_fuzzing check, GET-only (its POST form fuzzing needs form discovery this " +
    "project doesn't have). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `fuzz parameters for input validation issues: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanParamFuzzing(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
