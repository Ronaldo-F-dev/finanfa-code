import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's sqli.py, GET-only (its POST form testing needs
// --active-forms + form discovery, neither applicable here), scoped to
// the given URL's own query parameters. Sends real SQL-injection-style
// payloads (a single quote, boolean true/false conditions) — riskLevel
// "dangerous", not "ask" like the passive/GET-recon tools, since this is
// genuinely offensive testing of a SQL sink. Deliberately does not attempt
// time-based blind SQLi (SLEEP()/WAITFOR/pg_sleep) — that means
// deliberately loading the target's database for several seconds per
// parameter, a heavier footprint than error-based/boolean-based need.
const MAX_CANDIDATES = 15;
const LENGTH_TOLERANCE_BYTES = 40;
const ERROR_PAYLOAD = "'";
const BOOLEAN_TRUE = "' OR '1'='1'-- -";
const BOOLEAN_FALSE = "' OR '1'='2'-- -";
const BENIGN_VALUE = "1";

const SQL_ERROR_SIGNATURES = [
  /sql syntax.*mysql/i,
  /warning.*mysql_/i,
  /unclosed quotation mark/i,
  /quoted string not properly terminated/i,
  /pg_query\(\)/i,
  /postgresql.*error/i,
  /ora-\d{5}/i,
  /microsoft ole db provider for sql server/i,
  /sqlite3?\.(operationalerror|programmingerror)/i,
  /sqlstate\[/i,
];

function matchSqlError(body: string): string | undefined {
  for (const pattern of SQL_ERROR_SIGNATURES) {
    const match = pattern.exec(body);
    if (match) return match[0];
  }
  return undefined;
}

interface ProbeResponse {
  status: number;
  length: number;
}

function looksBooleanInjectable(baseline: ProbeResponse, trueResp: ProbeResponse, falseResp: ProbeResponse): boolean {
  if (trueResp.status !== falseResp.status) return true;
  if (Math.abs(trueResp.length - falseResp.length) <= LENGTH_TOLERANCE_BYTES) return false;
  return Math.abs(trueResp.length - baseline.length) < Math.abs(falseResp.length - baseline.length);
}

async function runProbes(target: URL, paramName: string): Promise<Finding | undefined> {
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

  let baseline: { status: number; length: number; text: string };
  try {
    baseline = await fetchWith(BENIGN_VALUE);
  } catch {
    return undefined;
  }

  try {
    const errorResponse = await fetchWith(ERROR_PAYLOAD);
    const signature = matchSqlError(errorResponse.text);
    if (signature) {
      const score = 9.8;
      const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
      return {
        id: `sqli-error-based-${digest}`,
        title: `SQL Injection (Error-Based) in '${paramName}'`,
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        cvssScore: score,
        cwe: "CWE-89",
        description: `Injecting a single quote into '${paramName}' triggers a database error message reflected in the response, confirming the input reaches a SQL query unsanitized.`,
        evidence: `GET ${location} with payload ${JSON.stringify(ERROR_PAYLOAD)} -> database error signature matched: ${JSON.stringify(signature)}`,
        impact: "An attacker can manipulate the SQL query to read, modify, or delete arbitrary data, and in some configurations achieve remote code execution via the database.",
        remediation: "Use parameterized queries/prepared statements exclusively; never concatenate user input into SQL strings. Disable verbose database error output in production.",
        affectedEndpoint: location,
      };
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
    const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
    return {
      id: `sqli-boolean-blind-${digest}`,
      title: `Possible Blind SQL Injection in '${paramName}' (Needs Manual Verification)`,
      severity: severityFromScore(score),
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cvssScore: score,
      cwe: "CWE-89",
      description: `Injecting always-true vs. always-false boolean SQL conditions into '${paramName}' produces meaningfully different responses — a heuristic signal of blind SQL injection, not a certainty.`,
      evidence: `GET ${location}: true-condition (${JSON.stringify(BOOLEAN_TRUE)}) and false-condition (${JSON.stringify(BOOLEAN_FALSE)}) payloads produced different response sizes/status codes.`,
      impact: "If confirmed, an attacker can extract data bit-by-bit via blind SQL injection even without visible error messages.",
      remediation: "Use parameterized queries/prepared statements exclusively. Manually verify this finding before remediation — boolean-based heuristics can false-positive on naturally dynamic pages.",
      affectedEndpoint: location,
    };
  }

  return undefined;
}

async function scanSqli(targetUrl: string): Promise<ScanOutput> {
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
    const found = await runProbes(target, paramName);
    if (found) findings.push(found);
  }

  if (candidates.length === 0) {
    passed.push({ label: "No injectable parameters found", detail: "No query parameters were found on the given URL (POST forms aren't tested — no form discovery in this project)." });
  } else if (findings.length === 0) {
    passed.push({
      label: "No SQL injection detected",
      detail: `Tested ${candidates.length} GET parameter(s) with error-based and boolean-based blind payloads; none indicated injection.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanSqliInput {
  url: string;
}

export const securityScanSqliTool: ToolDefinition<SecurityScanSqliInput> = {
  name: "security_scan_sqli",
  description:
    "Security tool. Tests a URL's query parameters for SQL injection: error-based (a single quote triggers a " +
    "database error signature — high confidence) and boolean-based blind (always-true vs always-false " +
    "conditions produce meaningfully different responses — heuristic, needs manual verification). Sends real " +
    "SQL-injection-style payloads to a live target. GET-only. Does NOT attempt time-based blind SQLi (SLEEP()/" +
    "WAITFOR) — that means deliberately loading the target's database for seconds per parameter, a heavier " +
    "footprint this tool avoids. A port of the user's own cyberlens scanner's sqli check. " +
    "IMPORTANT: only test a target you own or have explicit, documented authorization to test — this sends " +
    "real exploit-style payloads, unlike the passive/recon security_scan_* tools.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for SQL injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanSqli(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
