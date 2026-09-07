import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { multiEditFileTool } from "../../src/tools/builtin/multi-edit-file.js";

describe("multi_edit_file tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("applies several edits in order, each against the result of the previous one", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    const result = await multiEditFileTool.handler(
      {
        path: "a.txt",
        edits: [
          { old_string: "hello", new_string: "goodbye" },
          { old_string: "world", new_string: "moon" },
        ],
      },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("goodbye moon");
  });

  it("lets a later edit target text introduced by an earlier edit in the same call", async () => {
    await writeFile(path.join(dir, "a.txt"), "value = OLD_NAME;");
    const result = await multiEditFileTool.handler(
      {
        path: "a.txt",
        edits: [
          { old_string: "OLD_NAME", new_string: "TEMP_MARKER" },
          { old_string: "TEMP_MARKER", new_string: "NEW_NAME" },
        ],
      },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("value = NEW_NAME;");
  });

  it("writes nothing to disk when a later edit fails (atomic: all-or-nothing)", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    await expect(
      multiEditFileTool.handler(
        {
          path: "a.txt",
          edits: [
            { old_string: "hello", new_string: "goodbye" }, // would succeed on its own
            { old_string: "this text is not present", new_string: "x" }, // fails
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/edit #2.*not found/);
    // The file must be untouched — not even the first edit's effect.
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("hello world");
  });

  it("throws when an edit's old_string is ambiguous without replace_all", async () => {
    await writeFile(path.join(dir, "a.txt"), "foo foo");
    await expect(
      multiEditFileTool.handler({ path: "a.txt", edits: [{ old_string: "foo", new_string: "bar" }] }, ctx()),
    ).rejects.toThrow(/edit #1.*occurs 2 times/);
  });

  it("replaces all occurrences for an edit with replace_all set", async () => {
    await writeFile(path.join(dir, "a.txt"), "foo foo");
    const result = await multiEditFileTool.handler(
      { path: "a.txt", edits: [{ old_string: "foo", new_string: "bar", replace_all: true }] },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("bar bar");
  });

  it("rejects an empty edits array", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    await expect(
      multiEditFileTool.handler({ path: "a.txt", edits: [] }, ctx()),
    ).rejects.toThrow(/at least one edit/);
  });

  it("rejects paths escaping the project root", async () => {
    await expect(
      multiEditFileTool.handler(
        { path: "../outside.txt", edits: [{ old_string: "a", new_string: "b" }] },
        ctx(),
      ),
    ).rejects.toThrow(/outside the project root/);
  });
});
