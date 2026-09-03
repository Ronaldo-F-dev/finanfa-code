import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileTool } from "../../src/tools/builtin/read-file.js";
import { writeFileTool } from "../../src/tools/builtin/write-file.js";
import { editFileTool } from "../../src/tools/builtin/edit-file.js";
import { FileFreshnessTracker } from "../../src/core/file-freshness.js";

describe("read_file/write_file/edit_file: stale-write detection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-freshness-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctxWith = (fileFreshness: FileFreshnessTracker) => ({
    cwd: dir,
    sessionId: "s",
    signal: new AbortController().signal,
    fileFreshness,
  });

  it("write_file warns when the file changed since read_file last saw it", async () => {
    const tracker = new FileFreshnessTracker();
    await writeFile(path.join(dir, "a.txt"), "original");
    await readFileTool.handler({ path: "a.txt" }, ctxWith(tracker));

    // Simulate an external edit (a human, or another process) between the read and the write.
    await writeFile(path.join(dir, "a.txt"), "changed by someone else");

    const result = await writeFileTool.handler({ path: "a.txt", content: "agent's new content" }, ctxWith(tracker));
    expect(result.content).toContain("changed on disk since it was last read");
  });

  it("write_file does not warn when nothing changed since the last read", async () => {
    const tracker = new FileFreshnessTracker();
    await writeFile(path.join(dir, "a.txt"), "original");
    await readFileTool.handler({ path: "a.txt" }, ctxWith(tracker));

    const result = await writeFileTool.handler({ path: "a.txt", content: "agent's new content" }, ctxWith(tracker));
    expect(result.content).not.toContain("changed on disk");
  });

  it("write_file does not warn for a brand-new file never seen before", async () => {
    const tracker = new FileFreshnessTracker();
    const result = await writeFileTool.handler({ path: "brand-new.txt", content: "hello" }, ctxWith(tracker));
    expect(result.content).not.toContain("changed on disk");
  });

  it("edit_file warns when the file changed since it was last read, but still applies against current content", async () => {
    const tracker = new FileFreshnessTracker();
    await writeFile(path.join(dir, "a.txt"), "hello world");
    await readFileTool.handler({ path: "a.txt" }, ctxWith(tracker));

    await writeFile(path.join(dir, "a.txt"), "hello world, extended externally");

    const result = await editFileTool.handler(
      { path: "a.txt", old_string: "world", new_string: "there" },
      ctxWith(tracker),
    );
    expect(result.content).toContain("changed on disk since it was last read");
    expect(result.content).toContain("hello there, extended externally");
  });

  it("does not track a partial (offset/limit) read as the full known content", async () => {
    const tracker = new FileFreshnessTracker();
    await writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3");
    await readFileTool.handler({ path: "a.txt", offset: 1, limit: 1 }, ctxWith(tracker));

    await writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3-changed");

    const result = await writeFileTool.handler({ path: "a.txt", content: "new" }, ctxWith(tracker));
    expect(result.content).not.toContain("changed on disk");
  });

  it("subsequent writes after a warning don't keep re-warning once in sync", async () => {
    const tracker = new FileFreshnessTracker();
    await writeFile(path.join(dir, "a.txt"), "original");
    await readFileTool.handler({ path: "a.txt" }, ctxWith(tracker));
    await writeFile(path.join(dir, "a.txt"), "changed externally");

    const first = await writeFileTool.handler({ path: "a.txt", content: "agent content" }, ctxWith(tracker));
    expect(first.content).toContain("changed on disk");

    const second = await writeFileTool.handler({ path: "a.txt", content: "agent content v2" }, ctxWith(tracker));
    expect(second.content).not.toContain("changed on disk");
  });
});
