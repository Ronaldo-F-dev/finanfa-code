import { describe, expect, it } from "vitest";
import { FileFreshnessTracker } from "../../src/core/file-freshness.js";

describe("FileFreshnessTracker", () => {
  it("returns no warning for a path never seen before", () => {
    const tracker = new FileFreshnessTracker();
    expect(tracker.checkStale("/tmp/a.txt", "anything")).toBeUndefined();
  });

  it("returns no warning when current content matches what was recorded", () => {
    const tracker = new FileFreshnessTracker();
    tracker.record("/tmp/a.txt", "hello");
    expect(tracker.checkStale("/tmp/a.txt", "hello")).toBeUndefined();
  });

  it("warns when current content differs from what was last recorded", () => {
    const tracker = new FileFreshnessTracker();
    tracker.record("/tmp/a.txt", "hello");
    const warning = tracker.checkStale("/tmp/a.txt", "hello world, changed externally");
    expect(warning).toContain("/tmp/a.txt");
    expect(warning).toContain("changed on disk");
  });

  it("tracks paths independently", () => {
    const tracker = new FileFreshnessTracker();
    tracker.record("/tmp/a.txt", "a-content");
    tracker.record("/tmp/b.txt", "b-content");
    expect(tracker.checkStale("/tmp/a.txt", "a-content")).toBeUndefined();
    expect(tracker.checkStale("/tmp/b.txt", "different")).toBeDefined();
  });
});
