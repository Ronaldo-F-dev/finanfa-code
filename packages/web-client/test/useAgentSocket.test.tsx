// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSocket } from "../src/hooks/useAgentSocket";

// ws.onmessage used to JSON.parse every frame directly: one malformed frame
// (a truncated read, a stray proxy frame) threw out of the handler as an
// uncaught error. These drive the hook against a fake WebSocket to prove a
// bad frame is dropped and a valid frame right after still lands.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {}
}

describe("useAgentSocket frame handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it("ignores a malformed frame and still renders the next valid one", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useAgentSocket("m"));
    const ws = FakeWebSocket.instances.at(-1);
    expect(ws).toBeTruthy();

    expect(() =>
      act(() => ws!.onmessage?.({ data: "{not json" })),
    ).not.toThrow();

    act(() =>
      ws!.onmessage?.({
        data: JSON.stringify({ type: "system", text: "still here" }),
      }),
    );
    expect(
      result.current.timeline.some(
        (item) => item.kind === "log" && item.text === "still here",
      ),
    ).toBe(true);

    logged.mockRestore();
  });
});
