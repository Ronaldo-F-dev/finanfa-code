import type { ToolDefinition } from "../../core/types.js";
import type { BrowserManager } from "../../browser/manager.js";
import { resolveAllowedPath } from "./path-guard.js";
import { readImageFile } from "../../util/image.js";
import { wrapUntrustedContent } from "../../core/untrusted-content.js";

const MAX_TEXT_LENGTH = 8000;

function formatPage(url: string, title: string, text: string): string {
  const truncated = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\n... (truncated)` : text;
  return wrapUntrustedContent(url, `# ${title}\n\n${truncated}`);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Real browser automation via Playwright (Chromium): for JavaScript-rendered
 * pages that a plain fetch can't handle, or for visually inspecting/clicking
 * through a page. Distinct from web_fetch/web_search, which don't execute JS.
 */
export function createBrowserTools(manager: BrowserManager): ToolDefinition[] {
  const navigate: ToolDefinition<{ url: string }> = {
    name: "browser_navigate",
    description:
      "Open a URL in a real headless browser (Chromium) and return the page title and rendered text — " +
      "use this for JavaScript-heavy pages that web_fetch can't render. Keeps the page open for " +
      "browser_click/browser_screenshot.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to open" } },
      required: ["url"],
    },
    riskKey: (input) => hostnameOf(input.url),
    describeCall: (input) => `navigate to ${input.url}`,
    async handler(input) {
      const { title, text, url } = await manager.navigate(input.url);
      return { content: formatPage(url, title, text), isError: false };
    },
  };

  const click: ToolDefinition<{ selector: string }> = {
    name: "browser_click",
    description:
      "Click an element on the currently open browser page (CSS selector), then return the updated page " +
      "text. Requires browser_navigate to have been called first.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector of the element to click" } },
      required: ["selector"],
    },
    describeCall: (input) => `click "${input.selector}"`,
    async handler(input) {
      await manager.click(input.selector);
      const { title, text, url } = await manager.content();
      return { content: formatPage(url, title, text), isError: false };
    },
  };

  const screenshot: ToolDefinition<{ path: string }> = {
    name: "browser_screenshot",
    description:
      "Take a full-page screenshot of the currently open browser page, save it as a PNG file, and show it to " +
      "you so you can see what the page actually looks like. Requires browser_navigate to have been called first.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Where to save the PNG, relative to the project root" } },
      required: ["path"],
    },
    describeCall: (input) => `screenshot -> ${input.path}`,
    async handler(input, ctx) {
      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      await manager.screenshot(filePath);
      const read = await readImageFile(filePath, input.path);
      if (!read.ok) {
        // The screenshot was still saved to disk — just couldn't be shown inline.
        return { content: `Saved screenshot to ${input.path} (${read.error})`, isError: false };
      }
      return { content: `Saved screenshot to ${input.path}`, isError: false, images: [read.image] };
    },
  };

  return [navigate, click, screenshot];
}
