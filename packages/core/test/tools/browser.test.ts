import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrowserTools } from "../../src/tools/builtin/browser.js";
import type { BrowserManager } from "../../src/browser/manager.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeFakeManager(): BrowserManager {
  return {
    navigate: vi.fn().mockResolvedValue({ title: "Fake Page", text: "some page text", url: "https://example.com" }),
    click: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue({ title: "Fake Page", text: "clicked text", url: "https://example.com" }),
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
    vi.mocked(manager.navigate).mockResolvedValue({ title: "Big Page", text: "x".repeat(9000), url: "https://example.com" });
    const [navigate] = createBrowserTools(manager);

    const result = await navigate.handler({ url: "https://example.com" }, {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
    });

    expect(result.content).toContain("# Big Page");
    expect(result.content).toContain("truncated — full output is");
    expect(result.content).toContain("untrusted-external-content");
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

  it("browser_screenshot returns the saved PNG as image data for the model to see", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-browser-tool-"));
    try {
      const manager = makeFakeManager();
      vi.mocked(manager.screenshot).mockImplementation(async (filePath: string) => {
        await writeFile(filePath, ONE_PIXEL_PNG);
      });
      const [, , screenshot] = createBrowserTools(manager);

      const result = await screenshot.handler({ path: "out.png" }, {
        cwd: dir,
        sessionId: "s",
        signal: new AbortController().signal,
      });

      expect(result.isError).toBe(false);
      expect(result.images).toHaveLength(1);
      expect(result.images![0].mimeType).toBe("image/png");
      expect(Buffer.from(result.images![0].base64, "base64")).toEqual(ONE_PIXEL_PNG);
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
