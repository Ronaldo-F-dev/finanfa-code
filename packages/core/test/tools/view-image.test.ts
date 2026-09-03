import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { viewImageTool } from "../../src/tools/builtin/view-image.js";

// A real, minimal valid 1x1 PNG (not a fake/empty file) — its actual bytes matter here
// since the tool reads and base64-encodes the file, not just checks its existence.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("view_image tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-view-image-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("reads a real PNG file and returns it as base64 image data", async () => {
    await writeFile(path.join(dir, "shot.png"), ONE_PIXEL_PNG);

    const result = await viewImageTool.handler({ path: "shot.png" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.images).toHaveLength(1);
    expect(result.images![0].mimeType).toBe("image/png");
    expect(Buffer.from(result.images![0].base64, "base64")).toEqual(ONE_PIXEL_PNG);
  });

  it("rejects unsupported file extensions", async () => {
    await writeFile(path.join(dir, "notes.txt"), "hello");
    const result = await viewImageTool.handler({ path: "notes.txt" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported image type");
  });

  it("rejects paths escaping the project root", async () => {
    await expect(viewImageTool.handler({ path: "../outside.png" }, ctx())).rejects.toThrow(
      /outside the project root/,
    );
  });
});
