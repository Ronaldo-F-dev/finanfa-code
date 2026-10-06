import { describe, expect, it } from "vitest";
import { buildDiffRows } from "../src/diffRows";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n") + "\n";

describe("buildDiffRows", () => {
  it("shows a changed line as a removal and an addition, with correct line numbers", () => {
    const { rows, added, removed } = buildDiffRows("a\nb\nc\n", "a\nB\nc\n");
    expect(rows).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: "a" },
      { kind: "del", oldNo: 2, text: "b" },
      { kind: "add", newNo: 2, text: "B" },
      { kind: "ctx", oldNo: 3, newNo: 3, text: "c" },
    ]);
    expect([added, removed]).toEqual([1, 1]);
  });

  it("keeps numbering right across an insertion that shifts later lines", () => {
    const { rows } = buildDiffRows("a\nb\n", "a\nx\ny\nb\n");
    expect(rows).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: "a" },
      { kind: "add", newNo: 2, text: "x" },
      { kind: "add", newNo: 3, text: "y" },
      { kind: "ctx", oldNo: 2, newNo: 4, text: "b" },
    ]);
  });

  it("collapses unchanged lines far from a change into a gap, keeping `context` lines around it", () => {
    const before = lines(20);
    const after = before.replace("line10\n", "CHANGED\n");
    const { rows } = buildDiffRows(before, after, 2);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(["gap", "ctx", "ctx", "del", "add", "ctx", "ctx", "gap"]);
    expect(rows[0]).toEqual({ kind: "gap", hidden: 7 }); // lines 1..7
    expect(rows[7]).toEqual({ kind: "gap", hidden: 8 }); // lines 13..20
  });

  it("merges two nearby changes into one hunk, without a gap between them", () => {
    const before = lines(12);
    const after = before.replace("line3\n", "X\n").replace("line7\n", "Y\n");
    const { rows } = buildDiffRows(before, after, 3);
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(1); // only the tail after line 10
  });

  it("treats a brand-new file as all additions and a deleted file as all removals", () => {
    expect(buildDiffRows("", "a\nb\n")).toMatchObject({ added: 2, removed: 0, rows: [{ kind: "add", newNo: 1 }, { kind: "add", newNo: 2 }] });
    expect(buildDiffRows("a\nb\n", "")).toMatchObject({ added: 0, removed: 2, rows: [{ kind: "del", oldNo: 1 }, { kind: "del", oldNo: 2 }] });
  });

  it("returns no rows for identical content", () => {
    expect(buildDiffRows("same\n", "same\n")).toEqual({ rows: [], added: 0, removed: 0 });
    expect(buildDiffRows("", "")).toEqual({ rows: [], added: 0, removed: 0 });
  });

  it("notices a change that is only a missing final newline", () => {
    const { rows, added, removed } = buildDiffRows("a\nb", "a\nb\n");
    expect(added + removed).toBeGreaterThan(0);
    expect(rows.some((r) => r.kind !== "ctx" && r.kind !== "gap")).toBe(true);
  });

  it("refuses to diff something huge, so the browser never freezes", () => {
    expect(buildDiffRows("x".repeat(300_000), "y".repeat(300_000)).tooLarge).toBe(true);
    expect(buildDiffRows("", lines(9000)).tooLarge).toBe(true);
  });
});
