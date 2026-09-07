import { chromium, type Browser, type Page } from "playwright-core";

export interface PageContent {
  title: string;
  text: string;
  url: string;
  elements: InteractiveElement[];
}

export interface InteractiveElement {
  index: number;
  tag: string;
  type?: string;
  role?: string;
  label: string;
  href?: string;
}

const MARK_ATTR = "data-finanfa-idx";

// Written as a string (not a typed function) because this project's
// tsconfig has no DOM lib — matches the page.evaluate("...") convention
// used elsewhere (storage.ts, clickjacking.ts, xss.ts). Finds interactive
// elements two ways: (1) semantic tags/roles/handlers (a[href], button,
// input, textarea, select, common ARIA roles, [onclick]) — always
// included if visible; (2) a "looks clickable" heuristic (cursor:
// pointer, has visible text, not already captured) for framework-driven
// elements (a React onClick handler on a <div>) that carry no semantic
// marker at all — browser-use's own approach uses CDP's real event-
// listener introspection for this, which this project doesn't have; the
// cursor-pointer heuristic is a deliberately simpler, disclosed
// approximation that still catches the common "div styled as a button"
// case. Each matched element is tagged with a stable data-finanfa-idx
// attribute so a later click/fill call can target it precisely via
// Playwright's own selector engine, instead of the model having to
// construct a CSS selector against framework-generated markup.
const SNAPSHOT_SCRIPT = `(() => {
  const MARK_ATTR = "${MARK_ATTR}";
  document.querySelectorAll("[" + MARK_ATTR + "]").forEach((el) => el.removeAttribute(MARK_ATTR));

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 80);
    // A filled input's current value is more useful than its static
    // placeholder (which would otherwise misleadingly keep showing e.g.
    // "Your name" after the field has actually been filled in).
    if (el.value) return String(el.value).slice(0, 80);
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text.slice(0, 80);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 80);
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim().slice(0, 80);
    return "";
  }

  const results = [];
  let idx = 0;
  const seen = new Set();

  const semanticSelector = "a[href], button, input, textarea, select, [role='button'], [role='link'], [role='checkbox'], [role='tab'], [role='menuitem'], [role='option'], [onclick], summary";
  for (const el of Array.from(document.querySelectorAll(semanticSelector))) {
    if (seen.has(el) || !isVisible(el) || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
    seen.add(el);
    el.setAttribute(MARK_ATTR, String(idx));
    const tag = el.tagName.toLowerCase();
    results.push({
      index: idx,
      tag,
      type: el.getAttribute("type") || undefined,
      role: el.getAttribute("role") || undefined,
      label: accessibleName(el),
      href: tag === "a" ? el.getAttribute("href") || undefined : undefined,
    });
    idx++;
  }

  // Second pass: framework-attached click handlers with no semantic marker at all.
  for (const el of Array.from(document.querySelectorAll("div, span, li, td, [class]"))) {
    if (seen.has(el) || !isVisible(el)) continue;
    const style = window.getComputedStyle(el);
    if (style.cursor !== "pointer") continue;
    const label = accessibleName(el);
    if (!label) continue;
    seen.add(el);
    el.setAttribute(MARK_ATTR, String(idx));
    results.push({ index: idx, tag: el.tagName.toLowerCase(), label });
    idx++;
  }

  return results;
})()`;

/**
 * Lazily launches a single headless Chromium instance (via Playwright) and
 * keeps one page open across tool calls, so browser_navigate/browser_click/
 * browser_screenshot act on the same in-progress browsing session.
 */
export class BrowserManager {
  private browser: Browser | undefined;
  private page: Page | undefined;

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      try {
        this.browser = await chromium.launch({ headless: true });
      } catch (err) {
        throw new Error(
          "Failed to launch Chromium — has it been installed? Run `npx playwright install chromium`.\n" +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return this.browser;
  }

  private async ensurePage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    if (!this.page || this.page.isClosed()) {
      this.page = await browser.newPage();
    }
    return this.page;
  }

  async navigate(url: string): Promise<PageContent> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.content();
  }

  /** Clicks the element tagged with `index` by the most recent snapshot (navigate/click/fill/content all re-snapshot) — never a raw CSS selector, so a click still works reliably against framework-generated markup with unstable class names. */
  async click(index: number): Promise<void> {
    const page = await this.ensurePage();
    await page.click(`[${MARK_ATTR}="${index}"]`, { timeout: 10_000 });
  }

  /** Fills a text input/textarea tagged with `index` by the most recent snapshot. */
  async fill(index: number, value: string): Promise<void> {
    const page = await this.ensurePage();
    await page.fill(`[${MARK_ATTR}="${index}"]`, value, { timeout: 10_000 });
  }

  async content(): Promise<PageContent> {
    const page = await this.ensurePage();
    const title = await page.title();
    const text = await page.locator("body").innerText();
    const elements = (await page.evaluate(SNAPSHOT_SCRIPT)) as InteractiveElement[];
    return { title, text, url: page.url(), elements };
  }

  async screenshot(path: string): Promise<void> {
    const page = await this.ensurePage();
    await page.screenshot({ path, fullPage: true });
  }

  /**
   * Renders `html` to a PDF file. Uses its own throwaway page rather than
   * the shared browser_navigate/browser_click/browser_screenshot page, so a
   * conversion never disrupts whatever the model currently has open in the
   * interactive browsing session.
   */
  async printHtmlToPdf(html: string, outputPath: string): Promise<void> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
      await page.pdf({
        path: outputPath,
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
      });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }
}
