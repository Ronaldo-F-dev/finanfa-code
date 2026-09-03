import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileTool } from "../../src/tools/builtin/write-file.js";
import { editFileTool } from "../../src/tools/builtin/edit-file.js";
import { EditHistory } from "../../src/core/edit-history.js";

describe("write_file / edit_file record undo history", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-undo-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records 'before: undefined' when write_file creates a new file", async () => {
    const history = new EditHistory();
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal, history };

    await writeFileTool.handler({ path: "new.txt", content: "hello" }, ctx);

    const record = history.pop();
    expect(record).toEqual({ path: path.join(dir, "new.txt"), before: undefined });
  });

  it("records the previous content when write_file overwrites an existing file", async () => {
    await writeFile(path.join(dir, "existing.txt"), "old content");
    const history = new EditHistory();
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal, history };

    await writeFileTool.handler({ path: "existing.txt", content: "new content" }, ctx);

    const record = history.pop();
    expect(record).toEqual({ path: path.join(dir, "existing.txt"), before: "old content" });
  });

  it("records the previous content when edit_file changes an existing file", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    const history = new EditHistory();
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal, history };

    await editFileTool.handler({ path: "a.txt", old_string: "world", new_string: "there" }, ctx);

    const record = history.pop();
    expect(record).toEqual({ path: path.join(dir, "a.txt"), before: "hello world" });
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("hello there");
  });

  it("does not throw when no history is provided (optional field)", async () => {
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal };
    await expect(writeFileTool.handler({ path: "no-history.txt", content: "x" }, ctx)).resolves.toMatchObject({
      isError: false,
    });
  });
});
