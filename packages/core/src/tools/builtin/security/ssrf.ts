import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's ssrf.py, scoped to the given URL's own query
// parameters (see open-redirect.ts for why — no crawler here).
//
// Injects the cloud metadata service address into every URL-like
// parameter and confirms exploitation only via a small set of extremely
// distinctive response signatures (real cloud instance metadata content),
// never a generic status/timing difference. Deliberately does not attempt
// internal-port-scanning-style probes — a distinct, much noisier technique.
const MAX_CANDIDATES = 10;
const METADATA_PAYLOAD = "http://169.254.169.254/latest/meta-data/";
const DISCLOSURE_MARKERS = ["ami-id", "instance-id", "iam/security-credentials", "instance-life-cycle"];
const URL_LIKE_PARAM_NAME_PATTERN = /url|uri|link|callback|webhook|redirect|src|image|avatar|file|target|endpoint|site|domain|host|feed|proxy|fetch/i;

function selectUrlLikeParams(target: URL): string[] {
  const selected: string[] = [];
  for (const [name, value] of target.searchParams.entries()) {
    if (URL_LIKE_PARAM_NAME_PATTERN.test(name)) selected.push(name);
    else if (value.startsWith("http://") || value.startsWith("https://")) selected.push(name);
  }
  return [...new Set(selected)];
}

async function testParam(target: URL, paramName: string): Promise<Finding | undefined> {
  const url = new URL(target.toString());
  url.searchParams.set(paramName, METADATA_PAYLOAD);

  let response: Response;
  try {
    response = await fetch(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return undefined;
  }

  const body = (await response.text()).toLowerCase();
  if (!DISCLOSURE_MARKERS.some((m) => body.includes(m))) return undefined;

  const score = 8.6;
  const digest = createHash("sha1").update(`${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
  return {
    id: `ssrf-cloud-metadata-${digest}`,
    title: `Server-Side Request Forgery (SSRF) via '${paramName}'`,
    severity: severityFromScore(score),
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    cvssScore: score,
    cwe: "CWE-918",
    description: `Setting '${paramName}' to the cloud metadata service address (${METADATA_PAYLOAD}) causes the server to fetch it and return its contents.`,
    evidence: `GET ${url.toString()} -> response body contains cloud instance metadata content.`,
    impact:
      "On a cloud-hosted target, SSRF against the metadata endpoint routinely exposes the instance's IAM credentials, enabling full takeover of the cloud account's resources — one of the highest-impact web vulnerability classes in cloud environments.",
    remediation:
      "Validate and allow-list destination hosts for any server-side outbound request derived from user input. Block requests to link-local/internal address ranges (169.254.0.0/16, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) at the network layer as defense in depth.",
    affectedEndpoint: target.toString(),
  };
}

async function scanSsrf(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const candidates = selectUrlLikeParams(target).slice(0, MAX_CANDIDATES);

  for (const paramName of candidates) {
    const found = await testParam(target, paramName);
    if (found) findings.push(found);
  }

  if (candidates.length === 0) {
    passed.push({ label: "No URL-accepting parameters found", detail: "No query parameter on the given URL looked like it accepts a URL, by name or by its current value." });
  } else if (findings.length === 0) {
    passed.push({
      label: "No server-side request forgery detected",
      detail: `Tested ${candidates.length} URL-accepting parameter(s) with a cloud metadata endpoint payload; none of the responses disclosed metadata content.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanSsrfInput {
  url: string;
}

export const securityScanSsrfTool: ToolDefinition<SecurityScanSsrfInput> = {
  name: "security_scan_ssrf",
  description:
    "Security tool. Tests URL-accepting query parameters (named like url/callback/webhook/redirect/src/image/" +
    "proxy/fetch, or whose value is already a URL) for Server-Side Request Forgery — injects the cloud " +
    "metadata service address (169.254.169.254) and only flags a parameter when the response body actually " +
    "discloses real instance metadata content (ami-id, IAM credentials path, ...), never a generic status/" +
    "timing heuristic. GET-only, safe to run. A port of the user's own cyberlens scanner's ssrf check, scoped " +
    "to the given URL's own query string (no site crawler exists in this project). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for SSRF: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanSsrf(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
