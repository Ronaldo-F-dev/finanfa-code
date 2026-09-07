import { createHash, randomUUID } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's bfla.py. The anonymous-visitor check is the primary,
// unambiguous signal. The secondary authenticated-non-admin-session
// heuristic (a weaker signal — this tool has no way to know whether the
// account is legitimately an administrator) is now also ported: instead
// of `ctx.authenticated` + `ctx.client` carrying a pre-established
// session, this tool takes optional `headers` directly (same pattern as
// idor.ts) — the caller's own non-admin session. Candidates come from the
// curated path list plus, when the caller supplies `observedEndpoints`
// (e.g. from security_scan_crawler's observed GET XHR/fetch calls),
// any admin-keyword-matching URL among them — reusing crawler.ts output
// instead of an internal crawl. Uses the same soft-404 baseline technique
// as the original: a JS-SPA that serves the same 200 shell for every path
// shouldn't get every admin path flagged as reachable.
const MAX_CANDIDATES = 21;
const LENGTH_TOLERANCE_BYTES = 32;
const ADMIN_KEYWORD_RE = /admin|manage|internal|staff|moderator|superuser|privileged|backoffice/i;
const CANDIDATE_PATHS = [
  "/wp-admin/",
  "/administrator/",
  "/api/admin",
  "/api/admin/users",
  "/api/v1/admin",
  "/manage",
  "/management",
  "/console",
  "/actuator",
  "/actuator/env",
  "/actuator/health",
  "/_admin",
  "/superadmin",
  "/api/internal",
  "/cpanel",
  "/phpmyadmin",
];
const GATE_MARKERS = ["login", "sign in", "log in", "unauthorized", "access denied", "forbidden"];

interface Baseline {
  status: number;
  length: number;
  hash: string;
}

async function fetchBaseline(target: string): Promise<Baseline | undefined> {
  const probePath = `/finanfa-nonexistent-${randomUUID().slice(0, 12)}`;
  try {
    const response = await fetch(new URL(probePath, target).toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, length: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return undefined;
  }
}

async function looksFunctional(response: Response, baseline: Baseline | undefined): Promise<boolean> {
  if (response.status !== 200) return false;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (baseline && baseline.status === 200) {
    const bodyHash = createHash("sha256").update(bytes).digest("hex");
    if (bodyHash === baseline.hash) return false;
    if (Math.abs(bytes.length - baseline.length) < LENGTH_TOLERANCE_BYTES) return false;
  }

  const body = bytes.toString("utf-8").toLowerCase();
  return !GATE_MARKERS.some((marker) => body.includes(marker));
}

function bflaFinding(url: string, who: string, heuristic: boolean): Finding {
  const score = heuristic ? 5.3 : 8.1;
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 10);
  return {
    id: `bfla-${heuristic ? "heuristic" : "confirmed"}-${digest}`,
    title: heuristic ? "Possible Broken Function Level Authorization (Needs Manual Verification)" : "Broken Function Level Authorization (BFLA)",
    severity: severityFromScore(score),
    cvssVector: heuristic ? "AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N" : "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
    cvssScore: score,
    cwe: "CWE-862",
    description: `An admin/management-looking function at ${url} responded with what looks like real functional content to ${who}, instead of a login gate or permission error.`,
    evidence: `GET ${url} -> content distinct from the site's not-found baseline, with no login-gate marker in the response.`,
    impact: "A privileged administrative function reachable by users who shouldn't have access to it can lead to full application compromise, depending on what the function actually does.",
    remediation: "Enforce function-level authorization checks server-side on every privileged endpoint, independent of whether the UI hides the corresponding link/button for non-admin users.",
    affectedEndpoint: url,
  };
}

async function testCandidate(url: string, baseline: Baseline | undefined, headers?: Record<string, string>): Promise<Finding | PassedControl> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { label: `No BFLA confirmed on ${new URL(url).pathname}`, detail: "The anonymous request failed to complete." };
  }

  if (await looksFunctional(response, baseline)) {
    return bflaFinding(url, "an anonymous visitor", false);
  }

  if (headers) {
    try {
      const authResponse = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (await looksFunctional(authResponse, baseline)) {
        return bflaFinding(url, "the authenticated test account — verify it isn't legitimately an administrator", true);
      }
    } catch {
      // fall through to "not reachable" below
    }
  }

  return {
    label: `No BFLA confirmed on ${new URL(url).pathname}`,
    detail: `Not reachable anonymously${headers ? ", nor with the authenticated session." : "."}`,
  };
}

function isFinding(x: Finding | PassedControl): x is Finding {
  return "severity" in x;
}

async function scanBfla(targetUrl: string, headers?: Record<string, string>, observedEndpoints?: string[]): Promise<ScanOutput> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const path of CANDIDATE_PATHS) {
    const url = new URL(path, target).toString();
    if (!seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  }
  for (const url of observedEndpoints ?? []) {
    try {
      const parsed = new URL(url);
      if (!seen.has(url) && ADMIN_KEYWORD_RE.test(parsed.pathname)) {
        seen.add(url);
        candidates.push(url);
      }
    } catch {
      continue;
    }
  }
  const boundedCandidates = candidates.slice(0, MAX_CANDIDATES);

  const baseline = await fetchBaseline(target.toString());
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  for (const url of boundedCandidates) {
    const result = await testCandidate(url, baseline, headers);
    if (isFinding(result)) findings.push(result);
    else passed.push(result);
  }

  return { findings, passedControls: passed };
}

interface SecurityScanBflaInput {
  url: string;
  headers?: Record<string, string>;
  observedEndpoints?: string[];
}

export const securityScanBflaTool: ToolDefinition<SecurityScanBflaInput> = {
  name: "security_scan_bfla",
  description:
    "Security tool. Checks whether common admin/management function paths (wp-admin, Django-style " +
    "/administrator, Spring Boot Actuator, /manage, /console, /phpmyadmin, ...) are reachable by an anonymous " +
    "visitor with functional content, not a login gate — Broken Function Level Authorization. Uses a soft-404 " +
    "baseline so a JS-SPA serving the same shell for every path isn't misread as every admin path being " +
    "reachable. Optionally also retests with a supplied non-admin session's `headers` (a weaker heuristic " +
    "signal — this tool can't confirm the account isn't legitimately an administrator). Optionally accepts " +
    "`observedEndpoints` (e.g. from security_scan_crawler's observed GET XHR/fetch calls) and adds any " +
    "admin-keyword-matching URL among them as extra candidates. GET-only. A full port of the user's own " +
    "cyberlens scanner's bfla check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Target base URL, e.g. https://example.com" },
      headers: { type: "object", description: "Optional headers (e.g. Cookie/Authorization) for a non-admin authenticated session to also test", additionalProperties: { type: "string" } },
      observedEndpoints: { type: "array", items: { type: "string" }, description: "Optional URLs observed elsewhere (e.g. from security_scan_crawler) to check for admin-keyword matches" },
    },
    required: ["url"],
  },
  describeCall: (input) => `check function-level authorization (BFLA): ${input.url}`,
  async handler(input) {
    try {
      const output = await scanBfla(input.url, input.headers, input.observedEndpoints);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
