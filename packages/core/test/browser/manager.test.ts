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
  <input id="name" type="text" placeholder="Your name" />
  <div id="fake-button" style="cursor: pointer" onclick="document.getElementById('status').textContent = 'div clicked'">Looks like a button</div>
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

  it("navigates to a page and returns its title, rendered text, and a real interactive-elements snapshot", async () => {
    const { title, text, elements } = await manager.navigate(fixtureUrl);
    expect(title).toBe("Browser Manager Fixture");
    expect(text).toContain("before click");
    expect(elements).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "button", label: "Click me" })]));
  });

  it("finds the button by its real assigned index and clicks it — the page reflects the change", async () => {
    const { elements } = await manager.navigate(fixtureUrl);
    const button = elements.find((el) => el.tag === "button");
    expect(button).toBeDefined();
    await manager.click(button!.index);
    const { text } = await manager.content();
    expect(text).toContain("after click");
  });

  it("also detects a framework-style clickable <div> with no semantic tag/role, via the cursor:pointer heuristic", async () => {
    const { elements } = await manager.navigate(fixtureUrl);
    const fakeButton = elements.find((el) => el.label === "Looks like a button");
    expect(fakeButton).toBeDefined();
    expect(fakeButton!.tag).toBe("div");
    await manager.click(fakeButton!.index);
    const { text } = await manager.content();
    expect(text).toContain("div clicked");
  });

  it("fills a text input by its assigned index — the fresh snapshot then shows its real value, not the placeholder", async () => {
    const { elements: before } = await manager.navigate(fixtureUrl);
    const input = before.find((el) => el.tag === "input" && el.type === "text");
    expect(input).toBeDefined();
    expect(input!.label).toBe("Your name"); // placeholder, before filling

    await manager.fill(input!.index, "Ada Lovelace");
    const { elements: after } = await manager.content();
    const filledInput = after.find((el) => el.tag === "input" && el.type === "text");
    expect(filledInput!.label).toBe("Ada Lovelace");
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

  it("prints given HTML to a real PDF without disturbing the shared interactive browsing page", async () => {
    const { elements } = await manager.navigate(fixtureUrl);
    const button = elements.find((el) => el.tag === "button")!;
    await manager.click(button.index);

    const pdfPath = path.join(dir, "printed.pdf");
    await manager.printHtmlToPdf("<html><body><h1>Printed Content</h1></body></html>", pdfPath);

    const pdfBytes = await readFile(pdfPath);
    expect(pdfBytes.subarray(0, 5)).toEqual(Buffer.from("%PDF-"));

    // the shared page's post-click state must be untouched by the print
    const { text } = await manager.content();
    expect(text).toContain("after click");
  });
});
