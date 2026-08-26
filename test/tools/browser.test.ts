import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrowserTools } from "../../src/tools/builtin/browser.js";
import type { BrowserManager } from "../../src/browser/manager.js";

function makeFakeManager(): BrowserManager {
  return {
    navigate: vi.fn().mockResolvedValue({ title: "Fake Page", text: "some page text" }),
    click: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue({ title: "Fake Page", text: "clicked text" }),
    screenshot: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserManager;
}

describe("browser_* tools", () => {
  it("exposes navigate, click, and screenshot with sensible risk levels", () => {
    const [navigate, click, screenshot] = createBrowserTools(makeFakeManager());
    expect(navigate.name).toBe("browser_navigate");
    expect(navigate.riskLevel).toBe("ask");
    expect(click.name).toBe("browser_click");
    expect(click.riskLevel).toBe("ask");
    expect(screenshot.name).toBe("browser_screenshot");
    expect(screenshot.riskLevel).toBe("safe");
  });

  it("browser_navigate formats the page title and text, truncating long content", async () => {
    const manager = makeFakeManager();
    vi.mocked(manager.navigate).mockResolvedValue({ title: "Big Page", text: "x".repeat(9000) });
    const [navigate] = createBrowserTools(manager);

    const result = await navigate.handler({ url: "https://example.com" }, {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
    });

    expect(result.content).toContain("# Big Page");
    expect(result.content).toContain("(truncated)");
    expect(manager.navigate).toHaveBeenCalledWith("https://example.com");
  });

  it("browser_click delegates to the manager and returns the refreshed page content", async () => {
    const manager = makeFakeManager();
    const [, click] = createBrowserTools(manager);

    const result = await click.handler({ selector: "#go" }, {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
    });

    expect(manager.click).toHaveBeenCalledWith("#go");
    expect(result.content).toContain("clicked text");
  });

  it("browser_screenshot resolves the path within the project root and delegates to the manager", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-browser-tool-"));
    try {
      const manager = makeFakeManager();
      const [, , screenshot] = createBrowserTools(manager);

      const result = await screenshot.handler({ path: "out.png" }, {
        cwd: dir,
        sessionId: "s",
        signal: new AbortController().signal,
      });

      expect(result.isError).toBe(false);
      expect(manager.screenshot).toHaveBeenCalledWith(path.join(dir, "out.png"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("browser_screenshot rejects paths escaping the project root", async () => {
    const manager = makeFakeManager();
    const [, , screenshot] = createBrowserTools(manager);

    await expect(
      screenshot.handler({ path: "../outside.png" }, { cwd: "/tmp/proj", sessionId: "s", signal: new AbortController().signal }),
    ).rejects.toThrow(/outside the project root/);
  });
});
