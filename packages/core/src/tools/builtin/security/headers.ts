import type { ToolDefinition } from "../../../core/types.js";
import { scoreFromVector, severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

const CORS_PROBE_ORIGIN = "https://finanfa-code-cors-probe.invalid";
const VALID_XFO_VALUES = new Set(["DENY", "SAMEORIGIN"]);

interface MissingHeaderCheck {
  header: string;
  vector: string;
  cwe: string;
  description: string;
  impact: string;
  remediation: string;
}

// Same fixed set headers.py checks for — a direct port, not a reduced subset.
const MISSING_HEADER_CHECKS: MissingHeaderCheck[] = [
  {
    header: "content-security-policy",
    vector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N",
    cwe: "CWE-693",
    description: "No Content-Security-Policy header is set.",
    impact:
      "Increases the exploitability of any XSS vulnerability, since the browser has no policy restricting which scripts/styles/resources may execute or load.",
    remediation: "Add a restrictive Content-Security-Policy, e.g. Content-Security-Policy: default-src 'self'; script-src 'self'.",
  },
  {
    header: "permissions-policy",
    vector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N",
    cwe: "CWE-693",
    description: "No Permissions-Policy header is set.",
    impact: "Browser APIs (camera, microphone, geolocation, etc.) remain usable by embedded iframes or third-party scripts without restriction.",
    remediation: "Add Permissions-Policy: geolocation=(), camera=(), microphone=().",
  },
  {
    header: "cross-origin-opener-policy",
    vector: "AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N",
    cwe: "CWE-693",
    description: "No Cross-Origin-Opener-Policy (COOP) header is set.",
    impact:
      "Leaves the page's browsing context group open to cross-origin document access, which increases exposure to Spectre-class side-channel attacks.",
    remediation: "Add Cross-Origin-Opener-Policy: same-origin.",
  },
  {
    header: "cross-origin-embedder-policy",
    vector: "AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N",
    cwe: "CWE-693",
    description: "No Cross-Origin-Embedder-Policy (COEP) header is set.",
    impact: "Without COEP, cross-origin isolation cannot be enforced, which is a prerequisite for mitigating Spectre-class attacks.",
    remediation: "Add Cross-Origin-Embedder-Policy: require-corp (after verifying it does not break legitimate cross-origin resource loading).",
  },
  {
    header: "cross-origin-resource-policy",
    vector: "AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N",
    cwe: "CWE-693",
    description: "No Cross-Origin-Resource-Policy (CORP) header is set.",
    impact: "Resources can be loaded cross-origin without restriction, which can expose responses to cross-origin leak attacks.",
    remediation: "Add Cross-Origin-Resource-Policy: same-origin or same-site as appropriate.",
  },
];

const PRESENT_HEADER_LABELS: Record<string, string> = {
  "strict-transport-security": "HSTS",
  "referrer-policy": "Referrer-Policy",
};

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

function checkXPoweredBy(headers: Headers, target: string, findings: Finding[]): void {
  const value = headers.get("x-powered-by");
  if (!value) return;
  findings.push(
    finding(scoreFromVector("AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N"), {
      id: "headers-x-powered-by",
      title: "Technology Stack Disclosed via X-Powered-By",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
      cwe: "CWE-200",
      description: "The X-Powered-By response header discloses backend technology details.",
      evidence: `X-Powered-By: ${value}`,
      impact: "Knowing the exact framework/hosting stack lets an attacker search for and target known CVEs affecting that version.",
      remediation: "Remove or rewrite the X-Powered-By header at the proxy/framework level.",
      affectedEndpoint: target,
    }),
  );
}

function checkDeprecatedXssProtection(headers: Headers, findings: Finding[]): void {
  const value = headers.get("x-xss-protection");
  if (!value || value.trim() === "0") return;
  findings.push(
    finding(scoreFromVector("AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:N"), {
      id: "headers-deprecated-xss-protection",
      title: "Deprecated X-XSS-Protection Header",
      cvssVector: "AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:N",
      cwe: "CWE-693",
      description: `X-XSS-Protection is set to '${value}' but this header is deprecated since 2019 and removed/ignored by modern browsers, and can itself introduce XSS in older ones.`,
      evidence: `X-XSS-Protection: ${value}`,
      impact: "Gives a false impression of XSS protection with no real effect on modern browsers.",
      remediation: "Set X-XSS-Protection: 0 and rely on Content-Security-Policy instead.",
    }),
  );
}

function checkClickjackingProtection(headers: Headers, target: string, findings: Finding[], passed: PassedControl[]): void {
  const xfo = headers.get("x-frame-options")?.trim().toUpperCase() ?? "";
  const csp = headers.get("content-security-policy") ?? "";
  const hasFrameAncestors = csp.toLowerCase().includes("frame-ancestors");
  const hasValidXfo = VALID_XFO_VALUES.has(xfo);

  if (hasValidXfo || hasFrameAncestors) {
    const via = hasValidXfo ? `X-Frame-Options: ${xfo}` : "CSP frame-ancestors";
    passed.push({ label: "Clickjacking protection", detail: `Framing is restricted via ${via}.` });
    return;
  }

  findings.push(
    finding(4.3, {
      id: "headers-missing-clickjacking-protection",
      title: "Missing Clickjacking Protection",
      cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:N/A:N",
      cwe: "CWE-1021",
      description: "Neither a valid X-Frame-Options header (DENY/SAMEORIGIN) nor a Content-Security-Policy frame-ancestors directive is present.",
      evidence: `GET ${target} — X-Frame-Options: ${xfo || "(absent)"}, CSP frame-ancestors present: ${hasFrameAncestors}.`,
      impact: "The page can be embedded in an attacker-controlled iframe, enabling clickjacking (UI redress) attacks that trick users into performing unintended actions.",
      remediation: "Add Content-Security-Policy: frame-ancestors 'self' (preferred), or X-Frame-Options: DENY / SAMEORIGIN.",
      affectedEndpoint: target,
    }),
  );
}

function checkContentTypeOptions(headers: Headers, target: string, findings: Finding[], passed: PassedControl[]): void {
  const value = headers.get("x-content-type-options")?.trim().toLowerCase() ?? "";
  if (value === "nosniff") {
    passed.push({ label: "X-Content-Type-Options", detail: `X-Content-Type-Options is present: ${value}` });
    return;
  }
  findings.push(
    finding(5.3, {
      id: "headers-missing-content-type-options",
      title: "Missing X-Content-Type-Options Header",
      cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N",
      cwe: "CWE-693",
      description: "X-Content-Type-Options: nosniff is not set.",
      evidence: `GET ${target} — X-Content-Type-Options: ${value || "(absent)"}.`,
      impact:
        "Browsers may MIME-sniff the response into an executable content type (e.g. treating a user-uploaded file as HTML/JS) regardless of the declared Content-Type, which can enable XSS via file upload or other content-injection vectors.",
      remediation: "Add X-Content-Type-Options: nosniff to all responses.",
      affectedEndpoint: target,
    }),
  );
}

function checkCacheControl(headers: Headers, target: string, findings: Finding[], passed: PassedControl[]): void {
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return; // no session/auth state on this response — caching guidance doesn't clearly apply

  const cacheControl = headers.get("cache-control")?.toLowerCase() ?? "";
  if (cacheControl.includes("no-store")) {
    passed.push({ label: "Cache-Control on session-bearing response", detail: `Cache-Control: ${cacheControl}` });
    return;
  }

  findings.push(
    finding(4.3, {
      id: "headers-missing-cache-control-no-store",
      title: "Session-Bearing Response Missing Cache-Control: no-store",
      cvssVector: "AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N",
      cwe: "CWE-525",
      description: "A response that sets a cookie does not send Cache-Control: no-store.",
      evidence: `GET ${target} — Cache-Control: ${cacheControl || "(absent)"}, response also sets a cookie.`,
      impact:
        "Shared caches, proxies, or the browser's disk cache may store a response containing session-bound content, potentially exposing it to other users of the same cache or to later inspection of browser history/disk cache.",
      remediation: "Add Cache-Control: no-store (or at minimum private, no-cache) to any response that sets or depends on session/authentication cookies.",
      affectedEndpoint: target,
    }),
  );
}

function checkCookies(headers: Headers, findings: Finding[], passed: PassedControl[]): void {
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return;

  const insecure: { name: string; missing: string[] }[] = [];
  for (const raw of setCookies) {
    const lowered = raw.toLowerCase();
    const missing = [
      ["HttpOnly", "httponly"],
      ["Secure", "secure"],
    ]
      .filter(([, marker]) => !lowered.includes(marker))
      .map(([flag]) => flag);
    if (missing.length > 0) insecure.push({ name: raw.split("=")[0], missing });
  }

  if (insecure.length > 0) {
    const details = insecure.map((c) => `${c.name} missing ${c.missing.join(", ")}`).join("; ");
    findings.push(
      finding(6.5, {
        id: "headers-insecure-cookies",
        title: "Cookies Missing Security Flags",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
        cwe: "CWE-1004",
        description: "One or more cookies are missing the HttpOnly and/or Secure flags.",
        evidence: details,
        impact: "Cookies without HttpOnly are readable by client-side scripts (XSS exfiltration); without Secure they may be sent over plaintext HTTP.",
        remediation: "Set HttpOnly, Secure, and an appropriate SameSite value on all session/auth cookies.",
      }),
    );
  } else {
    passed.push({ label: "Secure cookies", detail: "All Set-Cookie headers include HttpOnly and Secure flags." });
  }

  checkSameSite(setCookies, findings, passed);
}

function checkSameSite(setCookies: string[], findings: Finding[], passed: PassedControl[]): void {
  const weak: string[] = [];
  for (const raw of setCookies) {
    const name = raw.split("=")[0];
    let sameSite: string | undefined;
    for (const part of raw.split(";")) {
      const trimmed = part.trim();
      if (trimmed.toLowerCase().startsWith("samesite=")) {
        sameSite = trimmed.split("=")[1]?.trim().toLowerCase();
        break;
      }
    }
    if (sameSite === undefined) weak.push(`${name} (no SameSite attribute)`);
    else if (sameSite === "none" && !raw.toLowerCase().includes("secure")) weak.push(`${name} (SameSite=None without Secure)`);
  }

  if (weak.length > 0) {
    findings.push(
      finding(4.3, {
        id: "headers-cookie-weak-samesite",
        title: "Cookies With Missing or Weak SameSite Attribute",
        cvssVector: "AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N",
        cwe: "CWE-352",
        description:
          "One or more cookies have no explicit SameSite attribute, or use SameSite=None without the Secure flag (a specification violation most browsers reject).",
        evidence: weak.join("; "),
        impact: "Without an explicit, strict SameSite value, a cookie is more likely to be sent on cross-site requests, weakening CSRF defenses in depth.",
        remediation:
          "Set SameSite=Lax or SameSite=Strict on session/auth cookies unless cross-site delivery is specifically required, in which case SameSite=None must be paired with Secure.",
      }),
    );
  } else {
    passed.push({ label: "Cookie SameSite", detail: "All Set-Cookie headers set an explicit, valid SameSite attribute." });
  }
}

async function checkCors(target: string, findings: Finding[], passed: PassedControl[]): Promise<void> {
  let response: Response;
  try {
    response = await fetch(target, { headers: { Origin: CORS_PROBE_ORIGIN }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return;
  }

  const allowOrigin = response.headers.get("access-control-allow-origin");
  const allowCredentials = response.headers.get("access-control-allow-credentials")?.toLowerCase() ?? "";

  let score: number;
  if (allowOrigin === "*" && allowCredentials === "true") score = 8.1;
  else if (allowOrigin === "*") score = 5.3;
  else if (allowOrigin === CORS_PROBE_ORIGIN) score = 8.1;
  else {
    passed.push({ label: "CORS policy", detail: "Origin is not reflected/wildcarded for an arbitrary probe origin." });
    return;
  }

  findings.push(
    finding(score, {
      id: "headers-cors-misconfiguration",
      title: "Permissive CORS Configuration",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
      cwe: "CWE-942",
      description: "The server reflects or wildcards Access-Control-Allow-Origin for an arbitrary, untrusted origin.",
      evidence: `Origin: ${CORS_PROBE_ORIGIN} => Access-Control-Allow-Origin: ${allowOrigin}, Access-Control-Allow-Credentials: ${allowCredentials || "unset"}`,
      impact:
        "A malicious page can make cross-origin requests to this API using a victim's browser session and read the response, especially dangerous when combined with credentialed requests.",
      remediation:
        "Restrict Access-Control-Allow-Origin to an explicit allow-list of trusted origins; never combine a wildcard/reflected origin with Access-Control-Allow-Credentials: true.",
      affectedEndpoint: target,
    }),
  );
}

async function scanHeaders(target: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let response: Response;
  try {
    response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`Could not reach ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const headers = response.headers;

  for (const [headerName, label] of Object.entries(PRESENT_HEADER_LABELS)) {
    if (headers.has(headerName)) passed.push({ label, detail: `${label} is present: ${headers.get(headerName)}` });
  }

  for (const check of MISSING_HEADER_CHECKS) {
    if (!headers.has(check.header)) {
      findings.push(
        finding(scoreFromVector(check.vector), {
          id: `headers-missing-${check.header}`,
          title: `Missing ${check.header} Header`,
          cvssVector: check.vector,
          cwe: check.cwe,
          description: check.description,
          evidence: `GET ${target} — response has no '${check.header}' header.`,
          impact: check.impact,
          remediation: check.remediation,
          affectedEndpoint: target,
        }),
      );
    }
  }

  checkXPoweredBy(headers, target, findings);
  checkDeprecatedXssProtection(headers, findings);
  checkClickjackingProtection(headers, target, findings, passed);
  checkContentTypeOptions(headers, target, findings, passed);
  checkCacheControl(headers, target, findings, passed);
  checkCookies(headers, findings, passed);
  await checkCors(target, findings, passed);

  return { findings, passedControls: passed };
}

interface SecurityScanHeadersInput {
  url: string;
}

export const securityScanHeadersTool: ToolDefinition<SecurityScanHeadersInput> = {
  name: "security_scan_headers",
  description:
    "Security tool. Check a URL's HTTP response for missing/misconfigured security headers, insecure cookie " +
    "flags, and permissive CORS — a direct, faithful port of the user's own cyberlens scanner's headers " +
    "check (CVSS-scored findings, same vectors/CWEs/remediation text). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test — " +
    "unauthorized scanning of third-party systems may be illegal. Ask the user to confirm authorization if " +
    "it isn't already clear from context, rather than assuming it.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `scan HTTP security headers: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanHeaders(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
