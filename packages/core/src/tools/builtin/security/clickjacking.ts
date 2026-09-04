import { chromium } from "playwright-core";
import type { ToolDefinition } from "../../../core/types.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Active confirmation, complementing security_scan_headers's passive check
// (which only checks whether X-Frame-Options/CSP frame-ancestors is
// *present*) — port of cyberlens's clickjacking.py, Chromium only (matching
// this project's existing browser tooling, vs. cyberlens's multi-engine
// Chromium/Firefox/WebKit run).
const NAV_TIMEOUT_MS = 25_000;
const FRAME_SETTLE_MS = 1500;
const FRAME_ID = "finanfa-clickjacking-target";

/**
 * Whether the iframe actually loaded the target, not the browser's own
 * "refused to connect" substitute page. A blocked frame can still have
 * non-empty body content (Chromium's own error page renders real DOM), so
 * this checks the frame's own URL matches the target's origin first —
 * a blocked frame reports an engine-specific placeholder (chrome-error://
 * on Chromium) instead of ever navigating to the real target.
 */
async function iframeRendered(page: import("playwright-core").Page, targetUrl: string): Promise<boolean> {
  try {
    const frameElement = await page.$(`#${FRAME_ID}`);
    if (!frameElement) return false;
    const frame = await frameElement.contentFrame();
    if (!frame) return false;

    const frameUrl = (frame.url() || "").trim();
    if (!frameUrl || frameUrl.startsWith("chrome-error://") || frameUrl.startsWith("about:")) return false;
    if (new URL(frameUrl).host !== new URL(targetUrl).host) return false;

    // A string (not a typed closure) — this file has no DOM lib, and the
    // callback runs in the browser's own context regardless of how it's
    // authored here.
    return Boolean(await frame.evaluate("document.body && document.body.innerHTML.length > 0"));
  } catch {
    return false;
  }
}

async function scanClickjacking(target: string): Promise<{ output: ScanOutput; screenshotBase64?: string }> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(`Failed to launch Chromium — run \`npx playwright install chromium\` first. Original error: ${err instanceof Error ? err.message : String(err)}`);
  }

  let screenshotBase64: string | undefined;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      const wrapperHtml = `<html><body><iframe id='${FRAME_ID}' src='${target}' style='width:800px;height:600px'></iframe></body></html>`;
      await page.setContent(wrapperHtml, { timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(FRAME_SETTLE_MS);
      const framed = await iframeRendered(page, target);

      if (framed) {
        screenshotBase64 = (await page.screenshot()).toString("base64");
        findings.push({
          id: "clickjacking-frame-confirmed",
          title: "Page Can Be Embedded in a Third-Party Iframe (Clickjacking Confirmed)",
          severity: "MEDIUM",
          cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N",
          cvssScore: 6.5,
          cwe: "CWE-1021",
          description: "A live browser test confirms the page renders inside an iframe from a different origin, not just that protective headers are absent.",
          evidence: `Loaded ${target} inside an <iframe> on an unrelated page; the framed content rendered successfully.`,
          impact:
            "Confirms clickjacking is practically exploitable: an attacker can overlay deceptive UI over the framed page to trick users into clicking hidden elements (UI redress).",
          remediation: "Add Content-Security-Policy: frame-ancestors 'self' (preferred) or X-Frame-Options: DENY/SAMEORIGIN.",
          affectedEndpoint: target,
        });
      } else {
        passed.push({ label: "Clickjacking (active test)", detail: "A live iframe-embedding attempt was blocked by the browser." });
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return { output: { findings, passedControls: passed }, screenshotBase64 };
}

interface SecurityScanClickjackingInput {
  url: string;
}

export const securityScanClickjackingTool: ToolDefinition<SecurityScanClickjackingInput> = {
  name: "security_scan_clickjacking",
  description:
    "Security tool. Actively confirms whether a page can really be embedded in a third-party iframe " +
    "(clickjacking), by rendering it inside one with a real headless Chromium and checking whether it actually " +
    "loaded — not just checking for the presence of protective headers (use security_scan_headers for that). " +
    "Requires Chromium (`npx playwright install chromium`). A faithful port of the user's own cyberlens " +
    "scanner's clickjacking check, Chromium-only (vs. its multi-engine run). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `actively test clickjacking: ${input.url}`,
  async handler(input) {
    try {
      const { output, screenshotBase64 } = await scanClickjacking(input.url);
      return {
        content: formatScanOutput(input.url, output),
        isError: false,
        images: screenshotBase64 ? [{ mimeType: "image/png", base64: screenshotBase64 }] : undefined,
      };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
