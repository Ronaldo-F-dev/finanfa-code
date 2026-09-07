import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's command_injection.py, GET-only, scoped to the given
// URL's own query parameters (see sqli.ts for why). riskLevel "dangerous"
// — sends real shell metacharacter payloads to a live target.
//
// Injects payloads designed to either (a) run a benign, recognizable
// command (id) with a very distinctive output shape (uid=...), or (b)
// break shell syntax in a way that produces a recognizable shell error.
// Deliberately does not attempt time-based blind detection (; sleep 5) —
// same reasoning as sqli.ts's own time-based exclusion. Genuinely blind
// command injection with no reflected output is an honest limitation of
// this error/output-based-only approach.
const MAX_CANDIDATES = 15;

const OUTPUT_PATTERN = /uid=\d+.*gid=\d+/;
const OUTPUT_PAYLOADS = ["; id", "| id", "`id`", "$(id)"];

const ERROR_SIGNATURES = [/sh: \d+: .*: (not found|command not found)/, /is not recognized as an internal or external command/, /\/bin\/sh: .*: command not found/, /cannot execute binary file/];
const BROKEN_SYNTAX_PAYLOAD = "; finanfa_nonexistent_cmd_9f3a1 ;";

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
  const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);

  for (const payload of OUTPUT_PAYLOADS) {
    let body: string;
    try {
      body = await fetchWith(payload);
    } catch {
      continue;
    }
    if (OUTPUT_PATTERN.test(body)) {
      const score = 9.8;
      return {
        id: `command-injection-confirmed-${digest}`,
        title: `OS Command Injection in '${paramName}'`,
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        cvssScore: score,
        cwe: "CWE-78",
        description: `Injecting a shell metacharacter payload into '${paramName}' causes an injected command (id) to actually execute, with its output reflected in the response.`,
        evidence: `GET ${location} with payload ${JSON.stringify(payload)} -> response contains command output matching /uid=\\d+.*gid=\\d+/.`,
        impact: "Full OS command injection: an attacker can run arbitrary commands with the privileges of the application process.",
        remediation: "Never pass user input to a shell/subprocess call. Use language-native APIs that don't invoke a shell (e.g. subprocess with a list of args and shell=False), and validate/allow-list input strictly if a shell call is unavoidable.",
        affectedEndpoint: location,
      };
    }
  }

  let errorBody: string;
  try {
    errorBody = await fetchWith(BROKEN_SYNTAX_PAYLOAD);
  } catch {
    return undefined;
  }

  for (const pattern of ERROR_SIGNATURES) {
    if (pattern.test(errorBody)) {
      const score = 8.6;
      return {
        id: `command-injection-error-${digest}`,
        title: `Possible OS Command Injection in '${paramName}' (Shell Error Observed)`,
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
        cvssScore: score,
        cwe: "CWE-78",
        description: `Injecting broken shell syntax into '${paramName}' produced a shell error message, indicating the input reaches a shell invocation.`,
        evidence: `GET ${location} with payload ${JSON.stringify(BROKEN_SYNTAX_PAYLOAD)} -> response contains a shell error signature.`,
        impact: "The input reaches a shell command; even without confirmed output, this is very likely exploitable for arbitrary command execution.",
        remediation: "Never pass user input to a shell/subprocess call. Use language-native APIs that don't invoke a shell.",
        affectedEndpoint: location,
      };
    }
  }

  return undefined;
}

async function scanCommandInjection(targetUrl: string): Promise<ScanOutput> {
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
      label: "No OS command injection detected",
      detail: `Tested ${candidates.length} GET parameter(s) with command-injection payloads; none showed command output or a shell error (blind injection with no reflected output would not be caught by this check).`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanCommandInjectionInput {
  url: string;
}

export const securityScanCommandInjectionTool: ToolDefinition<SecurityScanCommandInjectionInput> = {
  name: "security_scan_command_injection",
  description:
    "Security tool. Tests a URL's query parameters for OS command injection — injects shell metacharacter " +
    "payloads that either run a recognizable command (id, checked via its distinctive uid=...gid=... output) " +
    "or break shell syntax into a recognizable shell error. Sends real shell-injection payloads to a live " +
    "target. GET-only. Does not attempt time-based blind detection (; sleep 5) — genuinely blind injection " +
    "with no reflected output is an honest limitation. A port of the user's own cyberlens scanner's " +
    "command_injection check. " +
    "IMPORTANT: only test a target you own or have explicit, documented authorization to test — confirmed " +
    "command injection means arbitrary code execution on the target.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for OS command injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanCommandInjection(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
