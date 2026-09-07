import { createHash, randomUUID } from "node:crypto";
import { chromium, firefox, webkit, type Browser } from "playwright-core";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's xss.py, scoped to the given URL's own query
// parameters (see open-redirect.ts for why). Runs across every installed
// Playwright browser engine (Chromium/Firefox/WebKit) — an engine that
// isn't installed in the current environment is skipped, matching
// cyberlens's own run_across_engines/merge_engine_outputs behavior: a
// payload that executes in one engine but is neutralized by another
// (differing HTML parser quirks) is worth surfacing on its own, so a
// finding confirmed on only some of the tested engines is flagged as
// browser-inconsistent rather than silently merged away. Confirms
// execution (a JS handler actually firing) rather than checking whether
// the payload string is merely reflected in the response body — avoids
// the false positives naive string-matching produces when a reflected
// value is HTML-escaped. Never auto-submits POST forms.
const MAX_CANDIDATES = 15;
const NAV_TIMEOUT_MS = 20_000;
const ENGINES: { name: string; launcher: { launch: (opts: { headless: boolean }) => Promise<Browser> } }[] = [
  { name: "chromium", launcher: chromium },
  { name: "firefox", launcher: firefox },
  { name: "webkit", launcher: webkit },
];

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

// Exported for direct unit testing of the merge logic (pure/no I/O) — a
// real cross-engine "browser-inconsistent" payload is fiddly and version-
// dependent to construct reliably against real Chromium/Firefox, so this
// is tested directly against synthetic per-engine Finding lists instead.
export function mergeEngineFindings(perEngine: Map<string, Finding[]>): Finding[] {
  const testedEngines = [...perEngine.keys()].sort();
  const byId = new Map<string, { engine: string; finding: Finding }[]>();
  for (const [engine, findings] of perEngine) {
    for (const finding of findings) {
      const entries = byId.get(finding.id) ?? [];
      entries.push({ engine, finding });
      byId.set(finding.id, entries);
    }
  }

  const merged: Finding[] = [];
  for (const entries of byId.values()) {
    const confirmedOn = [...new Set(entries.map((e) => e.engine))].sort();
    const base = entries[0]!.finding;
    if (confirmedOn.length === testedEngines.length) {
      merged.push(base);
      continue;
    }
    merged.push({
      ...base,
      title: `${base.title} (Browser-Inconsistent)`,
      description: `${base.description} Confirmed on: ${confirmedOn.join(", ")}. NOT reproduced on: ${testedEngines.filter((e) => !confirmedOn.includes(e)).join(", ")} — the target's behavior differs by browser engine, which is itself worth investigating.`,
    });
  }
  return merged;
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

  const perEngineFindings = new Map<string, Finding[]>();
  const launchErrors: string[] = [];

  for (const { name, launcher } of ENGINES) {
    let browser: Browser;
    try {
      browser = await launcher.launch({ headless: true });
    } catch (err) {
      launchErrors.push(`${name}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      continue;
    }
    try {
      const findings: Finding[] = [];
      for (const paramName of candidates) {
        const found = await testParam(browser, target, paramName);
        if (found) findings.push(found);
      }
      perEngineFindings.set(name, findings);
    } finally {
      await browser.close();
    }
  }

  if (perEngineFindings.size === 0) {
    throw new Error(
      `Failed to launch any Playwright browser engine — run \`npx playwright install\` first. Errors: ${launchErrors.join("; ")}`,
    );
  }

  const findings = mergeEngineFindings(perEngineFindings);
  const passed: PassedControl[] = [];
  const testedEngines = [...perEngineFindings.keys()].sort();
  const skippedNote = launchErrors.length > 0 ? ` (${launchErrors.map((e) => e.split(":")[0]).join(", ")} not installed, skipped)` : "";

  if (findings.length === 0) {
    passed.push({
      label: "No reflected XSS confirmed",
      detail: `Tested ${candidates.length} GET parameter(s) with a browser-executed payload across every installed engine (${testedEngines.join(", ")})${skippedNote}; none executed.`,
    });
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
    "payload in every installed Playwright browser engine (Chromium/Firefox/WebKit — an engine missing from " +
    "the environment is skipped) and checking whether it executed (a JS handler firing), not just whether the " +
    "payload string appears in the response body — avoids false positives from HTML-escaped reflections. A " +
    "finding confirmed on only some engines is flagged Browser-Inconsistent rather than silently merged away. " +
    "GET-only, never submits POST forms. Requires at least one Playwright browser (`npx playwright install`). " +
    "A full port of the user's own cyberlens scanner's xss check, scoped to the given URL's own query string " +
    "(no site crawler feeds this automatically — see security_scan_crawler). " +
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
