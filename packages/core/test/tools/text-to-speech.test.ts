import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { textToSpeechTool } from "../../src/tools/builtin/text-to-speech.js";

describe("text_to_speech tool (real Google Translate TTS backend)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-tts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("has an ask risk level (writes a file)", () => {
    expect(textToSpeechTool.riskLevel).toBe("ask");
  });

  it(
    "writes a real MP3 file for a supported language (French)",
    async () => {
      const result = await textToSpeechTool.handler({ text: "Bonjour, comment allez-vous ?", lang: "fr", outputPath: "out.mp3" }, ctx());
      expect(result.isError).toBe(false);
      const bytes = await readFile(path.join(dir, "out.mp3"));
      expect(bytes.length).toBeGreaterThan(0);
      // MP3 files (or the ID3 tag wrapping them) start with either "ID3" or
      // an MPEG frame sync byte (0xFF) — a cheap real-content sanity check
      // that this isn't just base64 text mistakenly written raw.
      expect(bytes[0] === 0x49 || bytes[0] === 0xff).toBe(true);
    },
    15_000,
  );

  it(
    "reports a clear error for Yoruba — isSupported() for TEXT translation is true, but there is no TTS voice " +
      "for it, verified directly rather than assumed",
    async () => {
      const result = await textToSpeechTool.handler({ text: "Bawo ni", lang: "yo", outputPath: "out.mp3" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("yo");
      await expect(stat(path.join(dir, "out.mp3"))).rejects.toThrow();
    },
    15_000,
  );

  it("rejects a language Google Translate doesn't support at all, without making a network call", async () => {
    const result = await textToSpeechTool.handler({ text: "Bonjour", lang: "bariba", outputPath: "out.mp3" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("bariba");
  });

  it("describeCall summarizes the request, truncating long text", () => {
    expect(textToSpeechTool.describeCall?.({ text: "Bonjour", lang: "en", outputPath: "out.mp3" })).toBe("speak (en) to out.mp3: Bonjour");
    const long = "x".repeat(100);
    expect(textToSpeechTool.describeCall?.({ text: long, lang: "en", outputPath: "out.mp3" })).toBe(`speak (en) to out.mp3: ${"x".repeat(60)}…`);
  });
});
