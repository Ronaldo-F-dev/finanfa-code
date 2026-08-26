import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const spawnMock = vi.fn((..._args: unknown[]) => ({ unref: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: unknown) => spawnMock(command, args, options),
}));

const { previewHtmlTool } = await import("../../src/tools/builtin/preview-html.js");

describe("preview_html tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-preview-"));
    spawnMock.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("opens the file with the platform opener and reports success", async () => {
    await writeFile(path.join(dir, "mock.html"), "<html></html>");
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal };

    const result = await previewHtmlTool.handler({ path: "mock.html" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("mock.html");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect((args as string[]).some((a) => a.includes("mock.html"))).toBe(true);
  });

  it("rejects paths escaping the project root", async () => {
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal };
    await expect(previewHtmlTool.handler({ path: "../outside.html" }, ctx)).rejects.toThrow(
      /outside the project root/,
    );
  });
});
