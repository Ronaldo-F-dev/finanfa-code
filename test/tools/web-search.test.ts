import { describe, expect, it, vi, afterEach } from "vitest";
import { webSearchTool } from "../../src/tools/builtin/web-search.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

// A trimmed but structurally real fragment of DuckDuckGo's HTML results page
// (captured from a live query against html.duckduckgo.com/html/).
const DDG_HTML_FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fplaywright.dev%2F&amp;rut=abc">Fast and reliable end-to-end testing | Playwright</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fplaywright.dev%2F&amp;rut=abc"><b>Playwright</b> enables reliable web automation for testing &amp; scripting.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=def">Example Docs</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=def">Some docs about the example project.</a>
  </div>
</div>
`;

describe("web_search tool (DuckDuckGo, no API key required)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses titles, resolved URLs, and snippets out of DuckDuckGo's HTML results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(DDG_HTML_FIXTURE, { status: 200 })));

    const result = await webSearchTool.handler({ query: "playwright typescript" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Fast and reliable end-to-end testing | Playwright");
    expect(result.content).toContain("https://playwright.dev/");
    expect(result.content).toContain("Playwright enables reliable web automation");
    expect(result.content).toContain("Example Docs");
    expect(result.content).toContain("https://example.com/docs");
  });

  it("sends the query as a URL parameter, no API key/header required", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(DDG_HTML_FIXTURE, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.handler({ query: "finanfa-code" }, ctx);

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("q=finanfa-code");
    expect(String(url)).toContain("html.duckduckgo.com");
  });

  it("respects the count limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(DDG_HTML_FIXTURE, { status: 200 })));

    const result = await webSearchTool.handler({ query: "x", count: 1 }, ctx);
    expect(result.content).toContain("Fast and reliable end-to-end testing");
    expect(result.content).not.toContain("Example Docs");
  });

  it("returns '(no results)' when the page has no matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><body>no results</body></html>", { status: 200 })));

    const result = await webSearchTool.handler({ query: "asdkjhaskjdh" }, ctx);
    expect(result.content).toBe("(no results)");
  });

  it("propagates a clear error on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(webSearchTool.handler({ query: "x" }, ctx)).rejects.toThrow(/503/);
  });
});
