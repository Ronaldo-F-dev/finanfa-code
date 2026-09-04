import type { ToolDefinition } from "../../../core/types.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Direct port of cyberlens's waf.py — passive header/cookie signature
// fingerprinting plus an active behavioral probe (does a malicious-looking
// request get blocked differently than a benign one?). Informational only:
// a WAF's presence or absence is context for interpreting every other
// finding, not a vulnerability on its own — WAF rules are frequently
// bypassable and should never substitute for fixing a real finding.
const HEADER_SIGNATURES: { vendor: string; header: string; substring?: string }[] = [
  { vendor: "Cloudflare", header: "cf-ray" },
  { vendor: "Cloudflare", header: "server", substring: "cloudflare" },
  { vendor: "Akamai", header: "server", substring: "akamaighost" },
  { vendor: "Akamai", header: "x-akamai-transformed" },
  { vendor: "Sucuri", header: "x-sucuri-id" },
  { vendor: "Sucuri", header: "x-sucuri-cache" },
  { vendor: "Imperva/Incapsula", header: "x-iinfo" },
  { vendor: "AWS CloudFront/WAF", header: "x-amz-cf-id" },
  { vendor: "Fastly", header: "x-served-by", substring: "fastly" },
  { vendor: "F5 BIG-IP ASM", header: "server", substring: "big-ip" },
];

const COOKIE_SIGNATURES: { vendor: string; marker: string }[] = [
  { vendor: "Cloudflare", marker: "__cfduid" },
  { vendor: "Cloudflare", marker: "cf_clearance" },
  { vendor: "Imperva/Incapsula", marker: "incap_ses_" },
  { vendor: "Imperva/Incapsula", marker: "visid_incap_" },
  { vendor: "Barracuda", marker: "barra_counter_session" },
];

const BLOCKED_STATUS_CODES = new Set([403, 406, 429, 501]);
const PROBE_PAYLOAD = "<script>alert(1)</script>' OR '1'='1' UNION SELECT NULL-- -../../../etc/passwd";

function fingerprint(response: Response): string | undefined {
  for (const sig of HEADER_SIGNATURES) {
    const value = response.headers.get(sig.header);
    if (value === null) continue;
    if (!sig.substring || value.toLowerCase().includes(sig.substring)) return sig.vendor;
  }

  const cookieBlob = (response.headers.getSetCookie?.() ?? []).join(" ").toLowerCase();
  for (const sig of COOKIE_SIGNATURES) {
    if (cookieBlob.includes(sig.marker)) return sig.vendor;
  }
  return undefined;
}

function looksBlocked(baseline: Response, probe: Response): boolean {
  if (probe.status === baseline.status) return false;
  if (BLOCKED_STATUS_CODES.has(probe.status)) return true;
  return baseline.status === 200 && probe.status >= 400;
}

async function scanWaf(target: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let baseline: Response;
  try {
    baseline = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`Could not reach ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const vendor = fingerprint(baseline);

  let probe: Response | undefined;
  try {
    const probeUrl = new URL(target);
    probeUrl.searchParams.set("finanfa_waf_probe", PROBE_PAYLOAD);
    probe = await fetch(probeUrl.toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    probe = undefined;
  }

  const activeBlock = probe !== undefined && looksBlocked(baseline, probe);

  if (!vendor && !activeBlock) {
    passed.push({
      label: "No WAF detected",
      detail: "No known WAF/CDN signature matched, and a malicious-looking request was not blocked differently than a benign one.",
    });
    return { findings, passedControls: passed };
  }

  const evidenceParts: string[] = [];
  const signals: string[] = [];
  if (vendor) {
    evidenceParts.push(`Signature match: ${vendor}`);
    signals.push("response signatures");
  }
  if (activeBlock && probe) {
    evidenceParts.push(`A malicious-looking query parameter triggered HTTP ${probe.status} vs. a baseline of HTTP ${baseline.status}`);
    signals.push("active request blocking");
  }

  findings.push({
    id: "waf-detected",
    title: `Web Application Firewall Detected${vendor ? `: ${vendor}` : ""}`,
    severity: "INFO",
    description: `A WAF/CDN security layer appears to be in front of the target, based on ${signals.join(" and ")}.`,
    evidence: evidenceParts.join("; "),
    impact:
      "Informational: a WAF may absorb or alter some real-world exploit attempts, but should never be relied on as the only mitigation for findings elsewhere in this report — WAF rules are frequently bypassable, and this scan's own findings were not blocked by it.",
    remediation: "No action required; use this as context for prioritizing the other findings in this report, not as a substitute for fixing them.",
    affectedEndpoint: target,
  });

  return { findings, passedControls: passed };
}

interface SecurityScanWafInput {
  url: string;
}

export const securityScanWafTool: ToolDefinition<SecurityScanWafInput> = {
  name: "security_scan_waf",
  description:
    "Security tool. Detect whether a WAF/CDN security layer (Cloudflare, Akamai, Sucuri, Imperva, AWS " +
    "CloudFront, Fastly, F5 BIG-IP) sits in front of a target, via response header/cookie signatures plus a " +
    "behavioral probe (does a malicious-looking request get blocked differently than a benign one?) — a " +
    "faithful port of the user's own cyberlens scanner's WAF check. Informational only: a WAF's presence isn't " +
    "itself a vulnerability, and its absence isn't either — use it as context for other findings. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `detect WAF/CDN: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanWaf(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
