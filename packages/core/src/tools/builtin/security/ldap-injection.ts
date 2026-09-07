import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's ldap_injection.py, GET-only, scoped to the given
// URL's own query parameters (see sqli.ts for why). riskLevel "dangerous"
// — sends a real LDAP filter-breaking payload to a live target.
//
// Injects a payload designed to break out of an LDAP search filter
// (unbalanced parentheses / wildcard-OR injection) and checks for
// LDAP-specific error signatures. Deliberately does not attempt a
// boolean-blind differential test like sqli.ts/nosql-injection.ts: LDAP
// filter injection's behavioral signal is highly application-specific,
// and a generic differential probe here would be far more
// false-positive-prone than for SQL/NoSQL.
const MAX_CANDIDATES = 15;
const ERROR_PAYLOAD = "*)(uid=*))(|(uid=*";

const LDAP_ERROR_SIGNATURES = [/LDAPException/i, /javax\.naming\.(NamingException|directory)/i, /invalid DN syntax/i, /LDAP: error code \d+/i, /supplied argument is not a valid ldap/i, /System\.DirectoryServices/i];

async function probe(target: URL, paramName: string): Promise<Finding | undefined> {
  const url = new URL(target.toString());
  url.searchParams.set(paramName, ERROR_PAYLOAD);

  let body: string;
  try {
    const response = await fetch(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    body = await response.text();
  } catch {
    return undefined;
  }

  const location = (() => {
    const u = new URL(target.toString());
    u.searchParams.set(paramName, "<payload>");
    return u.toString();
  })();

  for (const pattern of LDAP_ERROR_SIGNATURES) {
    const match = pattern.exec(body);
    if (match) {
      const score = 8.6;
      const digest = createHash("sha1").update(`GET:${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
      return {
        id: `ldap-injection-${digest}`,
        title: `LDAP Injection in '${paramName}'`,
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
        cvssScore: score,
        cwe: "CWE-90",
        description: `Injecting an LDAP filter-breaking payload into '${paramName}' triggers an LDAP-specific error reflected in the response, confirming the input reaches an LDAP search filter unsanitized.`,
        evidence: `GET ${location} with payload ${JSON.stringify(ERROR_PAYLOAD)} -> LDAP error signature matched: ${JSON.stringify(match[0])}`,
        impact: "An attacker can manipulate the LDAP filter to bypass authentication or enumerate/read directory entries beyond what the application intends.",
        remediation: "Escape LDAP special characters in user input before building filters (RFC 4515), or use a library that constructs filters programmatically instead of by string concatenation.",
        affectedEndpoint: location,
      };
    }
  }

  return undefined;
}

async function scanLdapInjection(targetUrl: string): Promise<ScanOutput> {
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
    passed.push({ label: "No LDAP injection detected", detail: `Tested ${candidates.length} GET parameter(s) with an LDAP filter-injection payload; none showed an LDAP error signature.` });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanLdapInjectionInput {
  url: string;
}

export const securityScanLdapInjectionTool: ToolDefinition<SecurityScanLdapInjectionInput> = {
  name: "security_scan_ldap_injection",
  description:
    "Security tool. Tests a URL's query parameters for LDAP injection — injects a payload designed to break " +
    "out of an LDAP search filter (unbalanced parentheses / wildcard-OR injection) and checks for LDAP-" +
    "specific error signatures. Sends a real filter-breaking payload to a live target. GET-only. Does not " +
    "attempt a boolean-blind differential test (LDAP's behavioral signal is highly application-specific and " +
    "far more false-positive-prone than SQL/NoSQL's fixed true/false condition). A port of the user's own " +
    "cyberlens scanner's ldap_injection check. " +
    "IMPORTANT: only test a target you own or have explicit, documented authorization to test.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for LDAP injection: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanLdapInjection(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
