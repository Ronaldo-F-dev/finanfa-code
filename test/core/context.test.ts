import { describe, expect, it } from "vitest";
import { compactForProvider } from "../../src/core/context.js";
import type { NeutralMessage } from "../../src/core/types.js";

function toolMessage(id: string, content: string): NeutralMessage {
  return { role: "tool", results: [{ toolCallId: id, content, isError: false }] };
}

describe("compactForProvider", () => {
  it("returns messages unchanged when under budget", () => {
    const messages: NeutralMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    expect(compactForProvider(messages, 1000)).toEqual(messages);
  });

  it("collapses old large tool results once the conversation exceeds the budget", () => {
    const bigBlob = "x".repeat(2000);
    const messages: NeutralMessage[] = [
      { role: "user", content: "fetch page one" },
      toolMessage("c1", bigBlob),
      { role: "assistant", content: "here's page one" },
      { role: "user", content: "fetch page two" },
      toolMessage("c2", bigBlob),
      { role: "assistant", content: "here's page two" },
    ];

    // Budget in tokens; 4 chars/token estimate, so this is well under the
    // ~4000+4000 chars of tool content plus the rest of the conversation.
    const compacted = compactForProvider(messages, 100, 1);

    const first = compacted[1];
    expect(first.role).toBe("tool");
    if (first.role === "tool") {
      expect(first.results[0].content).toContain("omitted to save context");
      expect(first.results[0].content).not.toContain(bigBlob);
    }

    // Most recent tool message (keepRecentToolMessages = 1) is left intact.
    const second = compacted[4];
    expect(second.role).toBe("tool");
    if (second.role === "tool") {
      expect(second.results[0].content).toBe(bigBlob);
    }
  });

  it("never touches the original session.messages array or its objects", () => {
    const bigBlob = "y".repeat(2000);
    const original: NeutralMessage[] = [toolMessage("c1", bigBlob), toolMessage("c2", bigBlob)];
    const snapshot = JSON.parse(JSON.stringify(original));

    compactForProvider(original, 10, 0);

    expect(original).toEqual(snapshot);
  });

  it("leaves small tool results alone even when over budget", () => {
    const bigBlob = "z".repeat(2000);
    const messages: NeutralMessage[] = [toolMessage("c1", bigBlob), toolMessage("c2", "small result")];

    const compacted = compactForProvider(messages, 10, 0);

    const small = compacted[1];
    expect(small.role).toBe("tool");
    if (small.role === "tool") {
      expect(small.results[0].content).toBe("small result");
    }
  });
});
