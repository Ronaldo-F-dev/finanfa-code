import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const spawnMock = vi.fn((..._args: unknown[]) => ({ unref: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: unknown) => spawnMock(command, args, options),
}));

const { createArtifactTool } = await import("../../src/tools/builtin/create-artifact.js");
const { PreviewServer } = await import("../../src/core/preview-server.js");

describe("create_artifact tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-artifact-"));
    spawnMock.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("wraps App code in a self-contained HTML page, writes it, and serves it over a real http:// URL", async () => {
    const tool = createArtifactTool(new PreviewServer());
    const code = 'function App() { return <div className="hi">Hello</div>; }';

    const result = await tool.handler({ path: "widget.html", code }, ctx());

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    const url = (args as string[]).find((a) => a.startsWith("http://"));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/widget\.html$/);

    const written = await readFile(path.join(dir, "widget.html"), "utf-8");
    expect(written).toContain(code);
    expect(written).toContain("react.development.js");
    expect(written).toContain("react-dom.development.js");
    expect(written).toContain("babel.min.js");
    expect(written).toContain("cdn.tailwindcss.com");
    expect(written).toContain('ReactDOM.createRoot(document.getElementById("root")).render(<App />);');

    const response = await fetch(url as string);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(written);
  });

  it("escapes the title into the page but leaves the JSX code untouched", async () => {
    const tool = createArtifactTool(new PreviewServer());
    const code = "function App() { return <span>a {1 < 2 ? 'x' : 'y'} b</span>; }";

    await tool.handler({ path: "t.html", code, title: "<script>bad</script>" }, ctx());

    const written = await readFile(path.join(dir, "t.html"), "utf-8");
    expect(written).toContain("<title>&lt;script&gt;bad&lt;/script&gt;</title>");
    // the JSX itself (inside the babel script block) must be untouched, not HTML-escaped
    expect(written).toContain(code);
  });

  it("defaults the title to the file's base name when none is given", async () => {
    const tool = createArtifactTool(new PreviewServer());
    await tool.handler({ path: "dashboard.html", code: "function App() { return null; }" }, ctx());

    const written = await readFile(path.join(dir, "dashboard.html"), "utf-8");
    expect(written).toContain("<title>dashboard.html</title>");
  });

  it("rejects a path escaping the project root, before writing anything", async () => {
    const tool = createArtifactTool(new PreviewServer());
    await expect(
      tool.handler({ path: "../outside.html", code: "function App() { return null; }" }, ctx()),
    ).rejects.toThrow(/outside the project root/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns a unified diff in preview() against the wrapped HTML, same as write_file", async () => {
    const tool = createArtifactTool(new PreviewServer());
    const diff = await tool.preview?.({ path: "new.html", code: "function App() { return null; }" }, ctx());
    expect(diff).toContain("+function App()");
    expect(diff).toContain("+++");
  });

  it("embeds a self-polling reload script so an already-open tab picks up later edit_file changes", async () => {
    const tool = createArtifactTool(new PreviewServer());
    await tool.handler({ path: "live.html", code: "function App() { return null; }" }, ctx());

    const written = await readFile(path.join(dir, "live.html"), "utf-8");
    expect(written).toContain('cache: "no-store"');
    expect(written).toContain("location.reload()");
  });

  it("can be edited afterwards with edit_file, matching the exact JSX it wrote byte-for-byte", async () => {
    const { editFileTool } = await import("../../src/tools/builtin/edit-file.js");
    const tool = createArtifactTool(new PreviewServer());
    await tool.handler(
      { path: "w.html", code: 'function App() { return <button className="bg-blue-500">Go</button>; }' },
      ctx(),
    );

    const result = await editFileTool.handler(
      { path: "w.html", old_string: "bg-blue-500", new_string: "bg-green-500" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const written = await readFile(path.join(dir, "w.html"), "utf-8");
    expect(written).toContain('className="bg-green-500"');
    expect(written).toContain("react.development.js"); // rest of the wrapper survives untouched
  });
});
