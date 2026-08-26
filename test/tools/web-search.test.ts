import { describe, expect, it, vi, afterEach } from "vitest";
import { webSearchTool } from "../../src/tools/builtin/web-search.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("web_search tool", () => {
  const originalKey = process.env.BRAVE_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalKey;
  });

  it("returns a clear error when BRAVE_API_KEY is not set", async () => {
    delete process.env.BRAVE_API_KEY;
    const result = await webSearchTool.handler({ query: "test" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("BRAVE_API_KEY");
  });

  it("formats results from the Brave Search API", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Result A", url: "https://a.example", description: "First result" },
              { title: "Result B", url: "https://b.example", description: "Second result" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.handler({ query: "finanfa-code" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Result A");
    expect(result.content).toContain("https://a.example");
    expect(result.content).toContain("Result B");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("q=finanfa-code");
    expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("test-key");
  });

  it("propagates a clear error on a non-OK API response", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));

    await expect(webSearchTool.handler({ query: "x" }, ctx)).rejects.toThrow(/401/);
  });
});
