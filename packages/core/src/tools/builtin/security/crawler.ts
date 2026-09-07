import { chromium } from "playwright-core";
import type { ToolDefinition } from "../../../core/types.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Port of cyberlens's crawler.py: a same-origin site crawler that renders
// each page with real headless Chromium (not just a raw HTTP GET), so it
// still finds links/forms on JS-framework SPAs that serve an almost-empty
// HTML shell and build the real page client-side after load.
//
// Every other scanner ported into this project was rescoped to operate on
// a single given URL, since this project has no shared crawl/discovery
// pipeline feeding tool inputs the way cyberlens's ScanContext does — so
// this port stands alone as a recon tool: it reports a real site map
// (visited pages, discovered forms, same-origin links) the caller can read
// and then feed individual URLs from into the single-URL tools (idor,
// csrf, xss, account_creation, etc.), rather than silently populating
// shared state for them to consume.
const MAX_PAGES = 25;
const MAX_DEPTH = 3;
const NAV_TIMEOUT_MS = 25_000;
const RENDER_SETTLE_TIMEOUT_MS = 5_000;
const RENDER_SETTLE_FIXED_WAIT_MS = 1_500;
const MAX_OBSERVED_GET_REQUESTS = 200;

interface DiscoveredForm {
  pageUrl: string;
  action: string;
  method: "get" | "post";
  fieldCount: number;
  inferred: boolean;
}

interface PageExtract {
  links: string[];
  forms: DiscoveredForm[];
}

// Written as a string (not a typed arrow function) because this project's
// tsconfig has no DOM lib — the string body runs inside the page, not
// under this file's Node typechecking, matching the page.evaluate("...")
// convention already used in storage.ts/clickjacking.ts/xss.ts.
const EXTRACT_SCRIPT = `(() => {
  function fieldIdentifier(el) {
    return el.getAttribute("name") || el.getAttribute("id") || el.getAttribute("placeholder") || el.getAttribute("aria-label") || null;
  }

  const links = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href).filter(Boolean);

  const forms = [];
  for (const form of Array.from(document.querySelectorAll("form"))) {
    const fields = Array.from(form.querySelectorAll("input, textarea, select")).filter((el) => fieldIdentifier(el) !== null);
    if (fields.length === 0) continue;
    const hasPassword = fields.some((el) => el.type === "password");
    const methodAttr = (form.getAttribute("method") || "").trim().toLowerCase();
    forms.push({
      action: form.action || window.location.href,
      method: methodAttr || (hasPassword ? "post" : "get"),
      fieldCount: fields.length,
      inferred: false,
    });
  }

  const meaningfulTypes = new Set(["text", "email", "password", "tel", "number", "search", "url", "checkbox", "radio"]);
  const orphanFields = Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
    if (el.closest("form")) return false;
    if (el.tagName === "INPUT" && !meaningfulTypes.has(el.type || "text")) return false;
    return fieldIdentifier(el) !== null;
  });
  const orphanHasPassword = orphanFields.some((el) => el.type === "password");
  if (orphanFields.length > 0 && (orphanFields.length >= 2 || orphanHasPassword)) {
    forms.push({ action: window.location.href, method: "post", fieldCount: orphanFields.length, inferred: true });
  }

  return { links, forms };
})()`;

async function extractFromPage(page: import("playwright-core").Page, pageUrl: string, baseHost: string): Promise<PageExtract> {
  const raw = (await page.evaluate(EXTRACT_SCRIPT)) as { links: string[]; forms: { action: string; method: string; fieldCount: number; inferred: boolean }[] };

  const links = raw.links
    .map((link) => link.split("#", 1)[0])
    .filter((link) => {
      try {
        const parsed = new URL(link);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === baseHost;
      } catch {
        return false;
      }
    });

  const forms: DiscoveredForm[] = raw.forms.map((f) => ({
    pageUrl,
    action: f.action,
    method: f.method === "post" ? "post" : "get",
    fieldCount: f.fieldCount,
    inferred: f.inferred,
  }));

  return { links, forms };
}

async function crawlSite(targetUrl: string): Promise<ScanOutput> {
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

  const baseHost = target.host;
  const queue: Array<[string, number]> = [[target.toString(), 0]];
  const visited = new Set<string>();
  const discoveredForms: DiscoveredForm[] = [];
  const observedGetRequests: string[] = [];
  let getForms = 0;
  let postForms = 0;

  try {
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const next = queue.shift();
      if (!next) break;
      const [url] = next;
      const depth = next[1];
      if (visited.has(url)) continue;
      visited.add(url);

      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const page = await context.newPage();
        page.on("request", (req) => {
          if (req.method() !== "GET") return;
          if (!["xhr", "fetch"].includes(req.resourceType())) return;
          if (observedGetRequests.length >= MAX_OBSERVED_GET_REQUESTS) return;
          if (!observedGetRequests.includes(req.url())) observedGetRequests.push(req.url());
        });

        let response;
        try {
          response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });
        } catch {
          continue;
        }
        if (!response || response.status() !== 200) continue;
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("html")) continue;

        try {
          await page.waitForLoadState("networkidle", { timeout: RENDER_SETTLE_TIMEOUT_MS });
        } catch {
          // best-effort settle wait
        }
        await page.waitForTimeout(RENDER_SETTLE_FIXED_WAIT_MS);

        const { links, forms } = await extractFromPage(page, url, baseHost);

        if (depth < MAX_DEPTH) {
          for (const link of links) if (!visited.has(link)) queue.push([link, depth + 1]);
        }
        for (const form of forms) {
          discoveredForms.push(form);
          if (form.method === "post") postForms++;
          else getForms++;
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const visitedList = [...visited].sort();
  const formSummary = discoveredForms
    .slice(0, 10)
    .map((f) => `${f.method.toUpperCase()} ${f.action}${f.inferred ? " (inferred, no <form> tag)" : ""} — ${f.fieldCount} field(s)`)
    .join("; ");

  const finding: Finding = {
    id: "crawler-site-map",
    title: "Site Map Discovered",
    severity: "INFO",
    description: `Crawled ${visitedList.length} page(s) (same-origin, depth <= ${MAX_DEPTH}), finding ${getForms} GET form(s) and ${postForms} POST form(s). JavaScript-rendered content included (headless Chromium).`,
    evidence:
      `Visited: ${visitedList.slice(0, 10).join(", ")}${visitedList.length > 10 ? " ..." : ""}` +
      (formSummary ? ` | Forms: ${formSummary}${discoveredForms.length > 10 ? " ..." : ""}` : "") +
      (observedGetRequests.length > 0 ? ` | Observed GET XHR/fetch calls: ${observedGetRequests.slice(0, 10).join(", ")}${observedGetRequests.length > 10 ? " ..." : ""}` : ""),
    impact:
      "Informational — this is a real site map (not itself a vulnerability). Feed individual discovered URLs into the single-URL security_scan_* tools (idor, csrf, xss, account_creation, etc.) to test them; observed GET XHR/fetch endpoints are good idor candidates.",
    affectedEndpoint: target.toString(),
  };

  return { findings: [finding], passedControls: [] };
}

interface SecurityScanCrawlerInput {
  url: string;
}

export const securityScanCrawlerTool: ToolDefinition<SecurityScanCrawlerInput> = {
  name: "security_scan_crawler",
  description:
    "Security tool. Crawls a site same-origin, starting from a given URL, rendering each page in real headless " +
    `Chromium (so it still finds links/forms on JS-framework SPAs whose raw HTML is an almost-empty shell). ` +
    `Bounded to at most ${MAX_PAGES} pages and depth ${MAX_DEPTH} so this can't turn into an accidental crawl-everything against the target. ` +
    "Returns a real site map (visited pages, discovered forms with method/field-count, observed GET XHR/fetch " +
    "calls) as informational output — not itself a vulnerability finding. Use this first, then feed individual " +
    "discovered URLs into the single-URL security_scan_* tools (idor, csrf, xss, account_creation, etc.) to " +
    "test them; observed GET XHR/fetch endpoints are good idor candidates. Requires Chromium " +
    "(`npx playwright install chromium`). A port of the user's own cyberlens scanner's crawler check. " +
    "IMPORTANT: only crawl a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Starting URL to crawl, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `crawl site (same-origin) starting from: ${input.url}`,
  async handler(input) {
    try {
      const output = await crawlSite(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
