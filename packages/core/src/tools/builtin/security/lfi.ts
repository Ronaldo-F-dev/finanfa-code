import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's lfi.py, scoped to the given URL's own query
// parameters (see open-redirect.ts for why). GET-only, safe by default.
// Same two traversal-depth variants as the original (a plain chain, and a
// doubled form surviving a naive "strip ../ once" filter) — deliberately
// narrow rather than an exhaustive evasion suite. Linux /etc/passwd only,
// same reasoning as the original (overwhelmingly the more common target).
const MAX_CANDIDATES = 15;
const DISCLOSURE_MARKER = "root:x:0:0:";
const PAYLOADS = ["../../../../../../../../etc/passwd", "....//....//....//....//....//....//....//....//etc/passwd"];

async function testParam(target: URL, paramName: string): Promise<Finding | undefined> {
  for (const payload of PAYLOADS) {
    const url = new URL(target.toString());
    url.searchParams.set(paramName, payload);

    let response: Response;
    try {
      response = await fetch(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    } catch {
      continue;
    }

    const body = await response.text();
    if (body.includes(DISCLOSURE_MARKER)) {
      const score = 8.6;
      const digest = createHash("sha1").update(`${target.toString()}:${paramName}`).digest("hex").slice(0, 10);
      return {
        id: `lfi-confirmed-${digest}`,
        title: `Local File Inclusion / Path Traversal in '${paramName}'`,
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
        cvssScore: score,
        cwe: "CWE-22",
        description: `Injecting a path-traversal payload into '${paramName}' causes the server to read and return the contents of a local file (/etc/passwd) instead of the file it was supposed to serve.`,
        evidence: `GET ${url.toString()} -> response contains '${DISCLOSURE_MARKER}'.`,
        impact:
          "An attacker can read arbitrary files readable by the server process (source code, configuration, credentials), and depending on the application, sometimes escalate to remote code execution via log/file poisoning.",
        remediation:
          "Never build a filesystem path directly from user input. Map input to an allow-list of known-safe file identifiers instead of a raw path, or resolve and verify the final path stays within the intended base directory before opening it.",
        affectedEndpoint: target.toString(),
      };
    }
  }
  return undefined;
}

async function scanLfi(targetUrl: string): Promise<ScanOutput> {
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
    const found = await testParam(target, paramName);
    if (found) findings.push(found);
  }

  if (candidates.length === 0) {
    passed.push({ label: "No injectable parameters found", detail: "No query parameters were found on the given URL to test for path traversal." });
  } else if (findings.length === 0) {
    passed.push({
      label: "No local file inclusion detected",
      detail: `Tested ${candidates.length} GET parameter(s) with path-traversal payloads targeting /etc/passwd; none disclosed it.`,
    });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanLfiInput {
  url: string;
}

export const securityScanLfiTool: ToolDefinition<SecurityScanLfiInput> = {
  name: "security_scan_lfi",
  description:
    "Security tool. Tests a URL's query parameters for Local File Inclusion / path traversal — injects a " +
    "couple of traversal payloads targeting /etc/passwd and only flags a parameter when the response actually " +
    "discloses its contents, never a generic error/status heuristic. GET-only, safe to run. A port of the " +
    "user's own cyberlens scanner's lfi check, scoped to the given URL's own query string. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for LFI/path traversal: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanLfi(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
