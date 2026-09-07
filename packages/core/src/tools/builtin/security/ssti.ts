import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's ssti.py, GET-only, scoped to the given URL's own
// query parameters (see sqli.ts for why). riskLevel "dangerous" — sends a
// real template-expression payload to a live target.
//
// Injects a canary combining the delimiter syntaxes of several common
// template engines (Jinja2/Twig {{ }}, JSP/OGNL/Freemarker ${ }, ERB
// <%= %>, Ruby/JSF #{ }) in a single request. If the server evaluates any
// of them, 7*77 becomes the literal text 539 in the response — checked
// against a baseline to rule out coincidental matches.
const MAX_CANDIDATES = 15;
const CANARY_PAYLOAD = "{{7*77}}${7*77}<%= 7*77 %>#{7*77}";
const CANARY_RESULT = "539";
const BENIGN_VALUE = "test";

async function probe(target: URL, paramName: string): Promise<Finding | undefined> {
  const fetchWith = async (payload: string): Promise<string> => {
    const url = new URL(target.toString());
    url.searchParams.set(paramName, payload);
    const response = await fetch(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    return response.text();
  };

  const location = (() => {
    const u = new URL(target.toString());
    u.searchParams.set(paramName, "<payload>");
    return u.toString();
  })();

  let baseline: string;
  let payloadResponse: string;
  try {
    baseline = await fetchWith(BENIGN_VALUE);
    payloadResponse = await fetchWith(CANARY_PAYLOAD);
  } catch {
    return undefined;
  }

  if (payloadResponse.includes(CANARY_RESULT) && !baseline.includes(CANARY_RESULT)) {
    const score = 9.8;
    const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
    return {
      id: `ssti-confirmed-${digest}`,
      title: `Server-Side Template Injection in '${paramName}'`,
      severity: severityFromScore(score),
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cvssScore: score,
      cwe: "CWE-1336",
      description: `Injecting a template-expression canary into '${paramName}' causes it to be evaluated server-side: 7*77 was computed into 539 in the response instead of being reflected literally.`,
      evidence: `GET ${location} with payload ${JSON.stringify(CANARY_PAYLOAD)} -> response contains ${JSON.stringify(CANARY_RESULT)} (not present in the baseline response).`,
      impact: "Server-side template injection frequently leads to full remote code execution, since most template engines expose a path from expression evaluation to arbitrary code execution.",
      remediation: "Never pass user-supplied input into a template's source/expression context. Use the template engine strictly for rendering variables into a fixed template, never as a template string built from user input.",
      affectedEndpoint: location,
    };
  }

  return undefined;
}

async function scanSsti(targetUrl: string): Promise<ScanOutput> {
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
    passed.push({ label: "No SSTI detected", detail: `Tested ${candidates.length} GET parameter(s) with a template-injection canary; none evaluated it.` });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanSstiInput {
  url: string;
}

export const securityScanSstiTool: ToolDefinition<SecurityScanSstiInput> = {
  name: "security_scan_ssti",
  description:
    "Security tool. Tests a URL's query parameters for Server-Side Template Injection — injects a canary " +
    "combining several template engines' delimiter syntax (Jinja2/Twig, JSP/OGNL/Freemarker, ERB, Ruby) and " +
    "checks whether 7*77 got evaluated into the literal text 539 in the response, versus a baseline. Sends a " +
    "real template-expression payload to a live target. GET-only. A port of the user's own cyberlens " +
    "scanner's ssti check. " +
    "IMPORTANT: only test a target you own or have explicit, documented authorization to test — SSTI " +
    "frequently leads to full remote code execution if confirmed.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for server-side template injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanSsti(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
