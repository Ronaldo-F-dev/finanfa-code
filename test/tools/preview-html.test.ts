import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const spawnMock = vi.fn((..._args: unknown[]) => ({ unref: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: unknown) => spawnMock(command, args, options),
}));

const { createPreviewHtmlTool } = await import("../../src/tools/builtin/preview-html.js");
const { PreviewServer } = await import("../../src/core/preview-server.js");

describe("preview_html tool (real local HTTP server)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-preview-"));
    spawnMock.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("opens a real http:// URL (not file://) and the server actually serves the file's real content", async () => {
    await writeFile(path.join(dir, "mock.html"), "<html><body>hello preview</body></html>");
    const tool = createPreviewHtmlTool(new PreviewServer());

    const result = await tool.handler({ path: "mock.html" }, ctx());

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    const url = (args as string[]).find((a) => a.startsWith("http://"));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mock\.html$/);

    const response = await fetch(url as string);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<html><body>hello preview</body></html>");
  });

  it("serves a relative asset (CSS) alongside the HTML — the real reason file:// wasn't good enough", async () => {
    await writeFile(path.join(dir, "page.html"), '<link rel="stylesheet" href="style.css">');
    await writeFile(path.join(dir, "style.css"), "body { color: red; }");
    const tool = createPreviewHtmlTool(new PreviewServer());

    await tool.handler({ path: "page.html" }, ctx());
    const [, args] = spawnMock.mock.calls[0];
    const pageUrl = (args as string[]).find((a) => a.startsWith("http://")) as string;
    const cssUrl = pageUrl.replace("page.html", "style.css");

    const response = await fetch(cssUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body { color: red; }");
  });

  it("reuses the same server (same port) across multiple preview calls in one session", async () => {
    await writeFile(path.join(dir, "a.html"), "a");
    await writeFile(path.join(dir, "b.html"), "b");
    const server = new PreviewServer();
    const tool = createPreviewHtmlTool(server);

    await tool.handler({ path: "a.html" }, ctx());
    await tool.handler({ path: "b.html" }, ctx());

    const urlA = (spawnMock.mock.calls[0][1] as string[]).find((a) => a.startsWith("http://")) as string;
    const urlB = (spawnMock.mock.calls[1][1] as string[]).find((a) => a.startsWith("http://")) as string;
    expect(new URL(urlA).port).toBe(new URL(urlB).port);
  });

  it("the server itself refuses to serve a path that escapes the project root (HTTP-layer guard, not just the tool's own check)", async () => {
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "page.html"), "ok");
    const tool = createPreviewHtmlTool(new PreviewServer());

    await tool.handler({ path: "sub/page.html" }, ctx());
    const url = (spawnMock.mock.calls[0][1] as string[]).find((a) => a.startsWith("http://")) as string;
    const port = new URL(url).port;

    // A raw http.request with an un-normalized "../" segment — fetch()/the
    // URL API collapse "/../x" to "/x" before the request is even sent
    // (verified directly), which would make this test pass for the wrong
    // reason (a 404 on a normalized, harmless path) rather than actually
    // exercising the server's own boundary check against a real traversal
    // attempt reaching it.
    const http = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      http
        .request({ host: "127.0.0.1", port, path: "/sub/../../outside-the-root", method: "GET" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .end();
    });
    expect(status).toBe(403);
  });

  it("rejects paths escaping the project root at the tool layer, before ever starting a server", async () => {
    const tool = createPreviewHtmlTool(new PreviewServer());
    await expect(tool.handler({ path: "../outside.html" }, ctx())).rejects.toThrow(/outside the project root/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
