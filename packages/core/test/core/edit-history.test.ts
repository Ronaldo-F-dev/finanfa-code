import { describe, expect, it } from "vitest";
import { EditHistory } from "../../src/core/edit-history.js";

describe("EditHistory", () => {
  it("pops in LIFO order", () => {
    const history = new EditHistory();
    history.push({ path: "/a", before: "a1" });
    history.push({ path: "/b", before: "b1" });
    expect(history.pop()).toEqual({ path: "/b", before: "b1" });
    expect(history.pop()).toEqual({ path: "/a", before: "a1" });
    expect(history.pop()).toBeUndefined();
  });

  it("size reflects the number of pending records", () => {
    const history = new EditHistory();
    expect(history.size).toBe(0);
    history.push({ path: "/a", before: undefined });
    history.push({ path: "/b", before: undefined });
    expect(history.size).toBe(2);
    history.pop();
    expect(history.size).toBe(1);
  });

  describe("revertTo", () => {
    it("pops everything above targetSize, most-recent-first", () => {
      const history = new EditHistory();
      history.push({ path: "/a", before: "a0" });
      history.push({ path: "/b", before: "b0" });
      history.push({ path: "/c", before: "c0" });

      const reverted = history.revertTo(1);
      expect(reverted).toEqual([
        { path: "/c", before: "c0" },
        { path: "/b", before: "b0" },
      ]);
      expect(history.size).toBe(1);
    });

    it("reverting to the current size is a no-op", () => {
      const history = new EditHistory();
      history.push({ path: "/a", before: "a0" });
      expect(history.revertTo(1)).toEqual([]);
      expect(history.size).toBe(1);
    });

    it("reverting to 0 pops everything", () => {
      const history = new EditHistory();
      history.push({ path: "/a", before: "a0" });
      history.push({ path: "/b", before: "b0" });
      expect(history.revertTo(0)).toHaveLength(2);
      expect(history.size).toBe(0);
    });
  });
});
