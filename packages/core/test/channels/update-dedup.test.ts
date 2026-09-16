import { describe, expect, it } from "vitest";
import { UpdateDedupTracker } from "../../src/channels/update-dedup.js";

describe("UpdateDedupTracker", () => {
  it("returns true the first time an id is seen, false on a redelivery of the same id", () => {
    const tracker = new UpdateDedupTracker();
    expect(tracker.markSeen(1)).toBe(true);
    expect(tracker.markSeen(1)).toBe(false);
    expect(tracker.markSeen(2)).toBe(true);
  });

  it("evicts the oldest id once past its tracked-id limit, so a very old id can resurface as 'new' again", () => {
    const tracker = new UpdateDedupTracker(2);
    expect(tracker.markSeen(1)).toBe(true);
    expect(tracker.markSeen(2)).toBe(true);
    expect(tracker.markSeen(2)).toBe(false); // still tracked, well within the limit
    expect(tracker.markSeen(3)).toBe(true); // pushes the tracked set over its limit — evicts 1
    expect(tracker.markSeen(1)).toBe(true); // 1 was evicted, so it reads as "new" again
  });
});
