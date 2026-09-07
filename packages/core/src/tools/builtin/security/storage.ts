import { chromium } from "playwright-core";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { SECRET_PATTERNS, SENSITIVE_STORAGE_KEY_MARKERS, mask } from "./patterns.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's storage.py — browser-driven checks only observable
// by actually rendering the page: localStorage/sessionStorage contents,
// JS-readable auth cookies (missing HttpOnly), and mixed content on an
// HTTPS page. Chromium only (matching this project's existing browser
// tooling, vs. cyberlens's multi-engine Chromium/Firefox/WebKit run).
const NAV_TIMEOUT_MS = 25_000;

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

function checkStorageEntries(storageName: string, entries: Record<string, string>, target: string): Finding | undefined {
  if (Object.keys(entries).length === 0) return undefined;

  const flagged: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_STORAGE_KEY_MARKERS.some((marker) => keyLower.includes(marker))) {
      flagged.push(`${key} (sensitive key name)`);
      continue;
    }
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(String(value))) {
        flagged.push(`${key} (matches ${label} pattern: ${mask(String(value))})`);
        break;
      }
    }
  }

  if (flagged.length === 0) return undefined;

  return finding(6.5, {
    id: `storage-sensitive-${storageName.toLowerCase()}`,
    title: `Sensitive Data Stored in Browser ${storageName}`,
    cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N",
    cwe: "CWE-922",
    description: `${storageName} contains entries that look like authentication tokens, credentials, or API keys.`,
    evidence: flagged.join("; "),
    impact: `Unlike HttpOnly cookies, ${storageName} is readable by any JavaScript running on the page, so a single XSS vulnerability is enough to exfiltrate these values.`,
    remediation: `Store session/auth tokens in HttpOnly, Secure cookies instead of ${storageName}, or short-lived in-memory variables if a cookie isn't feasible.`,
    affectedEndpoint: target,
  });
}

function checkJsReadableAuthCookies(jsCookieString: string, browserCookies: { name: string }[], target: string): Finding | undefined {
  if (!jsCookieString) return undefined;

  const jsVisibleNames = new Set(
    jsCookieString
      .split(";")
      .map((part) => part.split("=", 1)[0]?.trim())
      .filter((n): n is string => Boolean(n)),
  );
  const authLikeNames = new Set(browserCookies.filter((c) => ["session", "token", "auth", "jwt"].some((m) => c.name.toLowerCase().includes(m))).map((c) => c.name));
  const exposed = [...jsVisibleNames].filter((n) => authLikeNames.has(n));

  if (exposed.length === 0) return undefined;

  return finding(6.5, {
    id: "storage-cookie-readable-via-js",
    title: "Session/Auth Cookie Readable via JavaScript",
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
    cwe: "CWE-1004",
    description: "A cookie whose name suggests it holds session/auth state is readable via document.cookie, meaning it is missing the HttpOnly flag.",
    evidence: `document.cookie exposes: ${exposed.sort().join(", ")}`,
    impact: "An XSS vulnerability anywhere on the page can exfiltrate this cookie and hijack the user's session.",
    remediation: "Set the HttpOnly flag on all session/authentication cookies.",
    affectedEndpoint: target,
  });
}

async function scanStorage(targetUrl: string): Promise<ScanOutput> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(`Failed to launch Chromium — run \`npx playwright install chromium\` first. Original error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      const mixedContentUrls: string[] = [];
      if (target.protocol === "https:") {
        page.on("request", (req) => {
          if (req.url().startsWith("http://")) mixedContentUrls.push(req.url());
        });
      }

      await page.goto(target.toString(), { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });

      const localStorage = (await page.evaluate("Object.fromEntries(Object.entries(window.localStorage))")) as Record<string, string>;
      const sessionStorage = (await page.evaluate("Object.fromEntries(Object.entries(window.sessionStorage))")) as Record<string, string>;
      const jsVisibleCookie = (await page.evaluate("document.cookie")) as string;
      const browserCookies = await context.cookies();

      const localFinding = checkStorageEntries("localStorage", localStorage, target.toString());
      if (localFinding) findings.push(localFinding);
      const sessionFinding = checkStorageEntries("sessionStorage", sessionStorage, target.toString());
      if (sessionFinding) findings.push(sessionFinding);
      const cookieFinding = checkJsReadableAuthCookies(jsVisibleCookie, browserCookies, target.toString());
      if (cookieFinding) findings.push(cookieFinding);

      if (mixedContentUrls.length > 0) {
        findings.push(
          finding(6.1, {
            id: "storage-mixed-content",
            title: "Mixed Content: Insecure Subresources on an HTTPS Page",
            cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N",
            cwe: "CWE-319",
            description: "The page loads one or more subresources over plain HTTP while served over HTTPS.",
            evidence: mixedContentUrls.slice(0, 5).join("; "),
            impact: "Insecure subresources can be intercepted or modified by a network attacker (e.g. to inject malicious JavaScript), undermining the page's HTTPS guarantees.",
            remediation: "Serve all subresources over HTTPS, or remove them.",
            affectedEndpoint: target.toString(),
          }),
        );
      } else if (target.protocol === "https:") {
        passed.push({ label: "No mixed content", detail: "All observed subresource requests used HTTPS." });
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return { findings, passedControls: passed };
}

interface SecurityScanStorageInput {
  url: string;
}

export const securityScanStorageTool: ToolDefinition<SecurityScanStorageInput> = {
  name: "security_scan_storage",
  description:
    "Security tool. Renders a page in a real headless Chromium and checks localStorage/sessionStorage for " +
    "entries that look like auth tokens/credentials/API keys, whether a session/auth-looking cookie is " +
    "readable via document.cookie (missing HttpOnly), and whether an HTTPS page loads any subresource over " +
    "plain HTTP (mixed content). Requires Chromium (`npx playwright install chromium`). A port of the user's " +
    "own cyberlens scanner's storage check, Chromium-only (vs. its multi-engine run). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `scan browser storage/cookies: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanStorage(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
