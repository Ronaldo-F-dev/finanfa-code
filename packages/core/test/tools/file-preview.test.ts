import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileTool } from "../../src/tools/builtin/write-file.js";
import { editFileTool } from "../../src/tools/builtin/edit-file.js";
import { multiEditFileTool } from "../../src/tools/builtin/multi-edit-file.js";

// Real end-to-end check of ToolDefinition.filePreview — the structured
// {path, before, after} a UI needs to render a real diff view (a native VS
// Code diff editor tab), distinct from preview()'s pre-formatted unified-diff
// STRING that readline/ink/web already render as-is. Every assertion here
// reads real files off a real temp directory, no mocking of fs.
describe("filePreview: structured before/after content for a real diff view", () => {
  let dir: string;
  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-file-preview-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("write_file", () => {
    it("reports the real prior content as before and the new content as after, for an existing file", async () => {
      await writeFile(path.join(dir, "a.txt"), "old content", "utf-8");
      const result = await writeFileTool.filePreview!({ path: "a.txt", content: "new content" }, ctx());
      expect(result).toEqual({ path: "a.txt", before: "old content", after: "new content" });
    });

    it("reports an empty before for a brand-new file, not an error", async () => {
      const result = await writeFileTool.filePreview!({ path: "new.txt", content: "hello" }, ctx());
      expect(result).toEqual({ path: "new.txt", before: "", after: "hello" });
    });

    it("decodes content_base64 the same way the real write does", async () => {
      const result = await writeFileTool.filePreview!({ path: "b.txt", content_base64: Buffer.from("décodé", "utf-8").toString("base64") }, ctx());
      expect(result).toEqual({ path: "b.txt", before: "", after: "décodé" });
    });

    it("returns undefined (no diff to show) instead of throwing when content/content_base64 are both given", async () => {
      const result = await writeFileTool.filePreview!({ path: "c.txt", content: "x", content_base64: "eA==" }, ctx());
      expect(result).toBeUndefined();
    });
  });

  describe("edit_file", () => {
    it("reports the real file's content before and after applying the edit", async () => {
      await writeFile(path.join(dir, "a.txt"), "hello world", "utf-8");
      const result = await editFileTool.filePreview!({ path: "a.txt", old_string: "world", new_string: "there" }, ctx());
      expect(result).toEqual({ path: "a.txt", before: "hello world", after: "hello there" });
    });

    it("returns undefined instead of throwing when old_string isn't found (stale content)", async () => {
      await writeFile(path.join(dir, "a.txt"), "hello world", "utf-8");
      const result = await editFileTool.filePreview!({ path: "a.txt", old_string: "not there", new_string: "x" }, ctx());
      expect(result).toBeUndefined();
    });
  });

  describe("multi_edit_file", () => {
    it("reports the file's content before any edit and after all edits are applied in order", async () => {
      await writeFile(path.join(dir, "a.txt"), "one two three", "utf-8");
      const result = await multiEditFileTool.filePreview!(
        { path: "a.txt", edits: [{ old_string: "one", new_string: "1" }, { old_string: "three", new_string: "3" }] },
        ctx(),
      );
      expect(result).toEqual({ path: "a.txt", before: "one two three", after: "1 two 3" });
    });

    it("returns undefined instead of throwing when an edit in the sequence fails", async () => {
      await writeFile(path.join(dir, "a.txt"), "one two three", "utf-8");
      const result = await multiEditFileTool.filePreview!(
        { path: "a.txt", edits: [{ old_string: "not there", new_string: "1" }] },
        ctx(),
      );
      expect(result).toBeUndefined();
    });
  });
});
