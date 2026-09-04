import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's xss.py, scoped to the given URL's own query
// parameters (see open-redirect.ts for why), Chromium only (matching this
// project's existing browser tooling — cyberlens's own version runs
// across Chromium/Firefox/WebKit). Confirms execution in a real browser
// (a JS handler actually firing) rather than checking whether the payload
// string is merely reflected in the response body — avoids the false
// positives naive string-matching produces when a reflected value is
// HTML-escaped. Never auto-submits POST forms.
const MAX_CANDIDATES = 15;
const NAV_TIMEOUT_MS = 20_000;

function payloadFor(marker: string): string {
  return `"><img src=x onerror="window.${marker}=1">`;
}

async function testParam(browser: import("playwright-core").Browser, target: URL, paramName: string): Promise<Finding | undefined> {
  const marker = `__finanfa_xss_${randomUUID().replaceAll("-", "").slice(0, 12)}__`;
  const testUrl = new URL(target.toString());
  testUrl.searchParams.set(paramName, payloadFor(marker));

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.dismiss());
    let executed = false;
    try {
      await page.goto(testUrl.toString(), { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });
      executed = Boolean(await page.evaluate(`window.${marker} === 1`));
    } catch {
      return undefined;
    }
    if (!executed) return undefined;
  } finally {
    await context.close();
  }

  const score = 8.8;
  // Hashed from (paramName, target) rather than testUrl: testUrl embeds a
  // random per-call marker, which would otherwise give the same
  // underlying vulnerability a different id on every run.
  const digest = createHash("sha1").update(`${paramName}:${target.toString()}`).digest("hex").slice(0, 10);
  return {
    id: `xss-reflected-${digest}`,
    title: `Reflected XSS in Parameter '${paramName}'`,
    severity: severityFromScore(score),
    cvssVector: "AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N",
    cvssScore: score,
    cwe: "CWE-79",
    description: `Injecting a script payload into the '${paramName}' parameter causes it to execute in the browser — confirmed by actual execution, not just string reflection.`,
    evidence: `GET ${testUrl.toString()} -> injected handler executed (window.${marker} was set).`,
    impact: "An attacker can craft a link that runs arbitrary JavaScript in a victim's browser session on this origin: session/cookie theft, credential harvesting, or page defacement.",
    remediation: "HTML-encode all user-supplied input before reflecting it into responses; adopt a strict Content-Security-Policy as defense in depth.",
    affectedEndpoint: testUrl.toString(),
  };
}

async function scanXss(targetUrl: string): Promise<{ output: ScanOutput }> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const candidates = [...new Set(target.searchParams.keys())].slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return {
      output: { findings: [], passedControls: [{ label: "No injectable GET parameters found", detail: "No URL query parameters were found on the given URL to test." }] },
    };
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
    for (const paramName of candidates) {
      const found = await testParam(browser, target, paramName);
      if (found) findings.push(found);
    }
  } finally {
    await browser.close();
  }

  if (findings.length === 0) {
    passed.push({ label: "No reflected XSS confirmed", detail: `Tested ${candidates.length} GET parameter(s) with a browser-executed payload; none executed.` });
  }

  return { output: { findings, passedControls: passed } };
}

interface SecurityScanXssInput {
  url: string;
}

export const securityScanXssTool: ToolDefinition<SecurityScanXssInput> = {
  name: "security_scan_xss",
  description:
    "Security tool. Tests a URL's query parameters for reflected XSS by actually rendering the injected " +
    "payload in a real headless Chromium and checking whether it executed (a JS handler firing), not just " +
    "whether the payload string appears in the response body — avoids false positives from HTML-escaped " +
    "reflections. GET-only, never submits POST forms. Requires Chromium (`npx playwright install chromium`). " +
    "A port of the user's own cyberlens scanner's xss check, Chromium-only (vs. its multi-engine run) and " +
    "scoped to the given URL's own query string (no site crawler exists in this project). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL with query parameters to test" } },
    required: ["url"],
  },
  describeCall: (input) => `test for reflected XSS: ${input.url}`,
  async handler(input) {
    try {
      const { output } = await scanXss(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
