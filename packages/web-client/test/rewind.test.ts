import { describe, expect, it } from "vitest";
import { restorePointsByClientId, truncateBeforeUserMessage } from "../src/rewind";
import type { TimelineItem } from "../src/hooks/useAgentSocket";

const user = (id: string, clientId: string | undefined, text: string): TimelineItem => ({ kind: "user", id, text, clientId });
const assistant = (id: string, text: string): TimelineItem => ({ kind: "assistant", id, text, streaming: false });
const note = (id: string): TimelineItem => ({ kind: "log", id, variant: "system", text: "note" });

describe("restorePointsByClientId", () => {
  it("maps only the points that carry a client id", () => {
    const map = restorePointsByClientId([
      { number: 1, preview: "a", clientId: "A" },
      { number: 2, preview: "auto-continue" },
      { number: 3, preview: "c", clientId: "C" },
    ]);
    expect([...map]).toEqual([["A", 1], ["C", 3]]);
  });

  it("is empty for no points", () => {
    expect(restorePointsByClientId([]).size).toBe(0);
  });
});

describe("truncateBeforeUserMessage", () => {
  const timeline = [user("1", "A", "first"), assistant("2", "answer one"), note("3"), user("4", "B", "second"), assistant("5", "answer two")];

  it("removes the message and everything after it, and hands back its text", () => {
    const result = truncateBeforeUserMessage(timeline, "B");
    expect(result.timeline.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(result.text).toBe("second");
  });

  it("can cut back to an empty conversation", () => {
    const result = truncateBeforeUserMessage(timeline, "A");
    expect(result.timeline).toEqual([]);
    expect(result.text).toBe("first");
  });

  it("leaves the timeline alone, with no text, when the message isn't there", () => {
    const result = truncateBeforeUserMessage(timeline, "nope");
    expect(result.timeline).toBe(timeline);
    expect(result.text).toBeUndefined();
  });

  it("ignores a user message that has no client id (one replayed from a saved session)", () => {
    const replayed = [user("1", undefined, "old question"), assistant("2", "old answer"), user("3", "N", "new")];
    const result = truncateBeforeUserMessage(replayed, "N");
    expect(result.timeline.map((i) => i.id)).toEqual(["1", "2"]);
  });
});
