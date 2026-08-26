import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserManager } from "../../src/browser/manager.js";

const FIXTURE_HTML = `<!doctype html>
<html>
<head><title>Browser Manager Fixture</title></head>
<body>
  <p id="status">before click</p>
  <button id="go" onclick="document.getElementById('status').textContent = 'after click'">Click me</button>
</body>
</html>`;

describe("BrowserManager (real Chromium via Playwright)", () => {
  let dir: string;
  let fixtureUrl: string;
  let manager: BrowserManager;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-browser-"));
    const fixturePath = path.join(dir, "fixture.html");
    await writeFile(fixturePath, FIXTURE_HTML, "utf-8");
    fixtureUrl = `file://${fixturePath}`;
    manager = new BrowserManager();
  });

  afterAll(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("navigates to a page and returns its title and rendered text", async () => {
    const { title, text } = await manager.navigate(fixtureUrl);
    expect(title).toBe("Browser Manager Fixture");
    expect(text).toContain("before click");
  });

  it("clicks an element and the page reflects the change", async () => {
    await manager.navigate(fixtureUrl);
    await manager.click("#go");
    const { text } = await manager.content();
    expect(text).toContain("after click");
  });

  it("saves a real PNG screenshot of the current page", async () => {
    await manager.navigate(fixtureUrl);
    const screenshotPath = path.join(dir, "shot.png");
    await manager.screenshot(screenshotPath);

    const bytes = await readFile(screenshotPath);
    // PNG magic number
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.length).toBeGreaterThan(100);
  });
});
