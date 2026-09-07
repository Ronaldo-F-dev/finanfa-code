import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { SECRET_PATTERNS, mask } from "./patterns.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Direct port of cyberlens's secrets.py — generic secret leakage and
// verbose-error information disclosure, from a single GET (plus one probe
// POST for the route-leak check). GET/POST, safe by default.
const STACK_TRACE_MARKERS = [/Traceback \(most recent call last\)/, /at Object\.<anonymous>/, /\.js:\d+:\d+/, /Fatal error:/];
const UNSUPPORTED_METHOD_PROBE_PATH = "/api/v1/admin/dashboard";

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

function scanBodyForSecrets(body: string, url: string): Finding[] {
  const findings: Finding[] = [];
  for (const { label, pattern, cwe, score } of SECRET_PATTERNS) {
    const match = pattern.exec(body);
    if (!match) continue;
    const masked = mask(match[0]);
    findings.push(
      finding(score, {
        id: `secrets-leak-${label.toLowerCase().replace(/ /g, "-")}`,
        title: `${label} Exposed in Response`,
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
        cwe,
        description: `A ${label.toLowerCase()} pattern was found in a public response body.`,
        evidence: `GET ${url} — matched pattern, value masked: ${masked}`,
        impact: "Exposed credentials/keys can be used directly to impersonate the service against the third-party provider or access sensitive data.",
        remediation: "Rotate the exposed credential immediately, move secrets to environment variables outside of any client-visible response, and add a generic error handler for third-party API failures.",
        affectedEndpoint: url,
      }),
    );
  }
  return findings;
}

function scanForStackTrace(body: string, url: string): Finding | undefined {
  for (const marker of STACK_TRACE_MARKERS) {
    if (marker.test(body)) {
      return finding(5.3, {
        id: "secrets-stack-trace-disclosure",
        title: "Stack Trace Disclosed in Response",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
        cwe: "CWE-209",
        description: "A raw stack trace was returned in an HTTP response body.",
        evidence: `GET ${url} — response body contains a stack-trace marker.`,
        impact: "Reveals internal file paths, framework internals, and code structure useful for crafting further attacks.",
        remediation: "Disable debug/verbose error output in production and return generic error messages to clients.",
        affectedEndpoint: url,
      });
    }
  }
  return undefined;
}

async function checkRouteLeakInErrors(target: string): Promise<Finding | undefined> {
  const path = UNSUPPORTED_METHOD_PROBE_PATH;
  const url = new URL(path, target).toString();
  let response: Response;
  let body: string;
  try {
    response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
    body = await response.text();
  } catch {
    return undefined;
  }

  if ((response.status === 404 || response.status === 405) && body.includes(path.replace(/^\/|\/$/g, ""))) {
    return finding(3.7, {
      id: "secrets-route-leak-in-error",
      title: "Internal Route Disclosed via Error Message",
      cvssVector: "AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N",
      cwe: "CWE-209",
      description: "An unsupported-method response echoes the exact internal route.",
      evidence: `POST ${url} -> HTTP ${response.status}, body: ${JSON.stringify(body.slice(0, 200))}`,
      impact: "Confirms the existence and exact structure of internal routes, easing reconnaissance.",
      remediation: "Return a generic 404/405 message that does not echo the requested path.",
      affectedEndpoint: url,
    });
  }
  return undefined;
}

async function scanSecrets(target: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let body: string;
  try {
    const response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    body = await response.text();
  } catch (err) {
    throw new Error(`Could not reach ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }

  findings.push(...scanBodyForSecrets(body, target));
  const stackTrace = scanForStackTrace(body, target);
  if (stackTrace) findings.push(stackTrace);
  const routeLeak = await checkRouteLeakInErrors(target);
  if (routeLeak) findings.push(routeLeak);

  if (findings.length === 0) {
    passed.push({ label: "No obvious secret/stack-trace leakage", detail: "No known secret patterns or stack traces observed in sampled responses." });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanSecretsInput {
  url: string;
}

export const securityScanSecretsTool: ToolDefinition<SecurityScanSecretsInput> = {
  name: "security_scan_secrets",
  description:
    "Security tool. Checks a page's response body for exposed secrets (Stripe/AWS/Google/GitHub/Slack keys, " +
    "private key blocks, Firebase config), a leaked stack trace, and whether an unsupported-method error " +
    "echoes an internal route back verbatim. GET (plus one probe POST), safe by default. A faithful port of " +
    "the user's own cyberlens scanner's secrets check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `scan for leaked secrets: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanSecrets(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
