import { describe, expect, it } from "vitest";
import { copyTextToClipboard } from "../src/clipboard";

// The code-copy button used to call navigator.clipboard.writeText(...)
// directly, with two silent failure modes: the Clipboard API is undefined in
// a non-secure context (plain http on a LAN address, an embedded webview),
// and writeText itself rejects when the document isn't focused or the user
// denies permission — neither was handled (crash / unhandled rejection, and
// a button that just did nothing). Same shape as urlState.ts: the
// clipboard-like object is a parameter, so this needs no DOM/jsdom.
describe("copyTextToClipboard", () => {
  it("copies through the Clipboard API and reports success", async () => {
    const written: string[] = [];
    const copied = await copyTextToClipboard("hello", {
      writeText: async (text) => {
        written.push(text);
      },
    });
    expect(copied).toBe(true);
    expect(written).toEqual(["hello"]);
  });

  it("reports failure instead of throwing when the Clipboard API is unavailable", async () => {
    expect(await copyTextToClipboard("hello", undefined)).toBe(false);
    expect(await copyTextToClipboard("hello", {})).toBe(false);
  });

  it("reports failure instead of an unhandled rejection when writeText rejects", async () => {
    const copied = await copyTextToClipboard("hello", {
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    });
    expect(copied).toBe(false);
  });
});
