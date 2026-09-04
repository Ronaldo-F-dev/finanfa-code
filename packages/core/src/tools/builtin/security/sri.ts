import type { ToolDefinition } from "../../../core/types.js";
import { scoreFromVector, severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's sri.py, scoped to a single page rather than a crawl —
// this project has no crawler scanner yet (cyberlens's own sri.py runs
// after its `crawler` scanner and checks up to MAX_PAGES=10 discovered
// pages; here there's only ever the one target URL given).
//
// Tag extraction is a narrow, targeted regex rather than a full HTML
// parser (no HTML-parsing dependency exists in this project yet) — safe
// for this specific job (finding <script src> / <link rel=stylesheet
// href> tags and an optional integrity attribute), not a general-purpose
// HTML parse.
const VECTOR = "AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N";
const SCRIPT_TAG_PATTERN = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;

function hasIntegrity(tag: string): boolean {
  return /\bintegrity=["'][^"']+["']/i.test(tag);
}

function extractStylesheetHref(tag: string): string | undefined {
  if (!/\brel=["']?[^"'>]*\bstylesheet\b/i.test(tag)) return undefined;
  const match = /\bhref=["']([^"']+)["']/i.exec(tag);
  return match?.[1];
}

interface ExternalResource {
  kind: "script" | "stylesheet";
  resource: string;
  hasIntegrity: boolean;
}

function extractExternalResources(html: string, pageUrl: string, baseHost: string): ExternalResource[] {
  const results: ExternalResource[] = [];

  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    const src = match[1];
    const absolute = resolveUrl(src, pageUrl);
    if (absolute && new URL(absolute).host !== baseHost) results.push({ kind: "script", resource: absolute, hasIntegrity: hasIntegrity(match[0]) });
  }

  for (const tag of html.match(LINK_TAG_PATTERN) ?? []) {
    const href = extractStylesheetHref(tag);
    if (!href) continue;
    const absolute = resolveUrl(href, pageUrl);
    if (absolute && new URL(absolute).host !== baseHost) results.push({ kind: "stylesheet", resource: absolute, hasIntegrity: hasIntegrity(tag) });
  }

  return results;
}

function resolveUrl(resource: string, base: string): string | undefined {
  try {
    const absolute = new URL(resource, base);
    return absolute.protocol === "http:" || absolute.protocol === "https:" ? absolute.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function scanSri(target: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let response: Response;
  try {
    response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`Could not reach ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.headers.get("content-type")?.includes("html")) {
    passed.push({ label: "Subresource Integrity", detail: "Response is not HTML — nothing to check." });
    return { findings, passedControls: passed };
  }

  const html = await response.text();
  const baseHost = new URL(target).host;
  const resources = extractExternalResources(html, target, baseHost);

  const missing = resources.filter((r) => !r.hasIntegrity);

  if (missing.length > 0) {
    const score = scoreFromVector(VECTOR);
    const evidenceLines = missing.slice(0, 10).map((r) => `${target} -> <${r.kind}> ${r.resource}`);
    findings.push({
      id: "sri-missing-subresource-integrity",
      title: "Missing Subresource Integrity (SRI) on External Resources",
      severity: severityFromScore(score),
      cvssVector: VECTOR,
      cvssScore: score,
      cwe: "CWE-353",
      description: `${missing.length} externally-hosted script/stylesheet tag(s) load without an \`integrity\` attribute.`,
      evidence: evidenceLines.join("; ") + (missing.length > 10 ? " ..." : ""),
      impact:
        "If the third-party host or CDN serving the resource is compromised or the resource is served over an insecure/uncontrolled path, the browser will execute or apply the tampered content with no integrity check.",
      remediation:
        "Add an `integrity` attribute (SRI hash) and `crossorigin` attribute to every externally-hosted <script>/<link rel=stylesheet> tag, or self-host the resource.",
      affectedEndpoint: target,
    });
  } else if (resources.length > 0) {
    passed.push({ label: "Subresource Integrity", detail: "All externally-hosted script/stylesheet tags found use an `integrity` attribute." });
  } else {
    passed.push({ label: "Subresource Integrity", detail: "No externally-hosted script/stylesheet tags found requiring SRI." });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanSriInput {
  url: string;
}

export const securityScanSriTool: ToolDefinition<SecurityScanSriInput> = {
  name: "security_scan_sri",
  description:
    "Security tool. Flags externally-hosted <script>/<link rel=stylesheet> tags on a page that load without a " +
    "Subresource Integrity (integrity=...) attribute — a port of the user's own cyberlens scanner's SRI check, " +
    "scoped to a single page here (no site crawler exists in this project yet, unlike cyberlens's own " +
    "multi-page version). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Page URL to check, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `check subresource integrity: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanSri(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
