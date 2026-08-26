import { chromium, type Browser, type Page } from "playwright-core";

export interface PageContent {
  title: string;
  text: string;
}

/**
 * Lazily launches a single headless Chromium instance (via Playwright) and
 * keeps one page open across tool calls, so browser_navigate/browser_click/
 * browser_screenshot act on the same in-progress browsing session.
 */
export class BrowserManager {
  private browser: Browser | undefined;
  private page: Page | undefined;

  private async ensurePage(): Promise<Page> {
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
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
    }
    return this.page;
  }

  async navigate(url: string): Promise<PageContent> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.content();
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector, { timeout: 10_000 });
  }

  async content(): Promise<PageContent> {
    const page = await this.ensurePage();
    const title = await page.title();
    const text = await page.locator("body").innerText();
    return { title, text };
  }

  async screenshot(path: string): Promise<void> {
    const page = await this.ensurePage();
    await page.screenshot({ path, fullPage: true });
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }
}
