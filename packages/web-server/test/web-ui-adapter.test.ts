import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createWebUiAdapter, filePreviewForClient, MAX_FILE_PREVIEW_CHARS } from "../src/web-ui-adapter.js";

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = { OPEN: 1, readyState: 1, send: vi.fn((raw: string) => sent.push(JSON.parse(raw))) } as unknown as WebSocket;
  return { ws, sent };
}

describe("filePreviewForClient", () => {
  it("passes a normal before/after through, and nothing else the tool might have attached", () => {
    const preview = { path: "a.ts", before: "x", after: "y", secret: "nope" } as never;
    expect(filePreviewForClient(preview)).toEqual({ path: "a.ts", before: "x", after: "y" });
  });

  it("sends nothing for no preview, or for one too large to be useful", () => {
    expect(filePreviewForClient(undefined)).toBeUndefined();
    expect(filePreviewForClient({ path: "big", before: "x".repeat(MAX_FILE_PREVIEW_CHARS), after: "y" })).toBeUndefined();
  });
});

describe("web adapter askUser", () => {
  it("includes the file preview in the ask event so the browser can render a diff", async () => {
    const { ws, sent } = fakeSocket();
    const { adapter, resolvePending } = createWebUiAdapter(ws);
    const answer = adapter.askUser("allow?", "confirm", "call-1", { path: "src/a.ts", before: "old\n", after: "new\n" });
    expect(sent).toEqual([{ type: "ask", requestId: 1, prompt: "allow?", kind: "confirm", filePreview: { path: "src/a.ts", before: "old\n", after: "new\n" } }]);
    resolvePending(1, "y");
    expect(await answer).toBe("y");
  });

  it("still asks plainly when there is no file preview", async () => {
    const { ws, sent } = fakeSocket();
    const { adapter, resolvePending } = createWebUiAdapter(ws);
    const answer = adapter.askUser("run bash?", "confirm");
    expect(sent[0]).toMatchObject({ type: "ask", prompt: "run bash?", kind: "confirm" });
    expect(sent[0].filePreview).toBeUndefined();
    resolvePending(1, "n");
    expect(await answer).toBe("n");
  });
});
