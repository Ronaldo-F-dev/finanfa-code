import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { editFileTool } from "../../src/tools/builtin/edit-file.js";

describe("edit_file tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("replaces a unique occurrence", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    const result = await editFileTool.handler(
      { path: "a.txt", old_string: "world", new_string: "there" },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("hello there");
  });

  it("throws when old_string is not found", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    await expect(
      editFileTool.handler({ path: "a.txt", old_string: "missing", new_string: "x" }, ctx()),
    ).rejects.toThrow(/not found/);
  });

  it("throws when old_string is ambiguous without replace_all", async () => {
    await writeFile(path.join(dir, "a.txt"), "foo foo");
    await expect(
      editFileTool.handler({ path: "a.txt", old_string: "foo", new_string: "bar" }, ctx()),
    ).rejects.toThrow(/occurs 2 times/);
  });

  it("replaces all occurrences when replace_all is set", async () => {
    await writeFile(path.join(dir, "a.txt"), "foo foo");
    const result = await editFileTool.handler(
      { path: "a.txt", old_string: "foo", new_string: "bar", replace_all: true },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("bar bar");
  });

  it("rejects paths escaping the project root", async () => {
    await expect(
      editFileTool.handler(
        { path: "../outside.txt", old_string: "a", new_string: "b" },
        ctx(),
      ),
    ).rejects.toThrow(/outside the project root/);
  });
});
