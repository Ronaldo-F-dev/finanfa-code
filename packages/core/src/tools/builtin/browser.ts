import type { ToolDefinition } from "../../core/types.js";
import type { BrowserManager, InteractiveElement } from "../../browser/manager.js";
import { resolveAllowedPath } from "./path-guard.js";
import { readImageFile } from "../../util/image.js";
import { wrapUntrustedContent } from "../../core/untrusted-content.js";
import { truncateOrSpill, TRUNCATE_TINY } from "../../util/truncate.js";

const MAX_ELEMENTS_SHOWN = 60;

function formatElements(elements: InteractiveElement[]): string {
  if (elements.length === 0) return "(no interactive elements found on this page)";
  const shown = elements.slice(0, MAX_ELEMENTS_SHOWN);
  const lines = shown.map((el) => {
    const typeAttr = el.type ? ` type=${el.type}` : "";
    const roleAttr = el.role ? ` role=${el.role}` : "";
    const tagDescriptor = `<${el.tag}${typeAttr}${roleAttr}>`;
    const parts = [`[${el.index}]`, tagDescriptor];
    if (el.label) parts.push(JSON.stringify(el.label));
    if (el.href) parts.push(`href=${el.href}`);
    return parts.join(" ");
  });
  if (elements.length > shown.length) lines.push(`... (${elements.length - shown.length} more not shown)`);
  return lines.join("\n");
}

async function formatPage(cwd: string, sessionId: string, url: string, title: string, text: string, elements: InteractiveElement[]): Promise<string> {
  const truncated = await truncateOrSpill(cwd, sessionId, "browser-page", text, TRUNCATE_TINY);
  return wrapUntrustedContent(url, `# ${title}\n\n${truncated}\n\n## Interactive elements (click/fill by index, not by CSS selector)\n${formatElements(elements)}`);
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
 *
 * Interaction is index-based (browser-use's "Set-of-Marks" approach), not
 * CSS-selector-based: every navigate/click/fill response lists the page's
 * interactive elements with a stable numeric index (assigned by a real-DOM
 * snapshot in browser/manager.ts, tagging each element with a hidden
 * data-finanfa-idx attribute), and click/fill target that index instead of
 * the model having to construct a CSS selector against often-unstable,
 * framework-generated class names/structure.
 */
export function createBrowserTools(manager: BrowserManager): ToolDefinition[] {
  const navigate: ToolDefinition<{ url: string }> = {
    name: "browser_navigate",
    description:
      "Open a URL in a real headless browser (Chromium) and return the page title, rendered text, and a " +
      "numbered list of interactive elements (buttons, links, inputs, ...) — use this for JavaScript-heavy " +
      "pages that web_fetch can't render. Keeps the page open for browser_click/browser_fill/" +
      "browser_screenshot, which reference elements by the index shown here, not a CSS selector.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to open" } },
      required: ["url"],
    },
    riskKey: (input) => hostnameOf(input.url),
    describeCall: (input) => `navigate to ${input.url}`,
    async handler(input, ctx) {
      await manager.navigate(input.url);
      const { title, text, url, elements } = await manager.content();
      return { content: await formatPage(ctx.cwd, ctx.sessionId, url, title, text, elements), isError: false };
    },
  };

  const click: ToolDefinition<{ index: number }> = {
    name: "browser_click",
    description:
      "Click an interactive element on the currently open browser page, by its numeric index from the most " +
      "recent browser_navigate/browser_click/browser_fill response's element list — then return the updated " +
      "page text and a fresh element list (indices can change after the click). Requires browser_navigate to " +
      "have been called first.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { index: { type: "number", description: "Index of the element to click, from the last element list shown" } },
      required: ["index"],
    },
    describeCall: (input) => `click element [${input.index}]`,
    async handler(input, ctx) {
      await manager.click(input.index);
      const { title, text, url, elements } = await manager.content();
      return { content: await formatPage(ctx.cwd, ctx.sessionId, url, title, text, elements), isError: false };
    },
  };

  const fill: ToolDefinition<{ index: number; value: string }> = {
    name: "browser_fill",
    description:
      "Fill a text input/textarea on the currently open browser page, by its numeric index from the most " +
      "recent element list — replaces its current content, then returns the updated page text and a fresh " +
      "element list. Requires browser_navigate to have been called first.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number", description: "Index of the input/textarea to fill, from the last element list shown" },
        value: { type: "string", description: "Text to fill it with" },
      },
      required: ["index", "value"],
    },
    describeCall: (input) => `fill element [${input.index}] with ${JSON.stringify(input.value)}`,
    async handler(input, ctx) {
      await manager.fill(input.index, input.value);
      const { title, text, url, elements } = await manager.content();
      return { content: await formatPage(ctx.cwd, ctx.sessionId, url, title, text, elements), isError: false };
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

  return [navigate, click, fill, screenshot];
}
