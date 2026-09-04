import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { speak, isSupported } from "google-translate-api-x";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface TextToSpeechInput {
  text: string;
  lang: string;
  outputPath: string;
}

// isSupported() reflects Google Translate's *text* language list, which is
// broader than its TTS voice list — verified directly, not assumed: real
// speak() calls succeed for e.g. "sw" (Swahili) and "ha" (Hausa) but fail
// for "yo" (Yoruba) and "fon", even though isSupported() reports true for
// both (translate_text's own Fon/Yoruba support is unaffected by this — the
// text translation and speech-synthesis language lists are just different).
// No fixed list of which languages have a voice is published, so this is
// discovered per-call rather than pre-filtered.
export const textToSpeechTool: ToolDefinition<TextToSpeechInput> = {
  name: "text_to_speech",
  description:
    "Convert text to speech and save it as an MP3, via the same free Google Translate backend translate_text " +
    "uses — no configuration needed. Note: Google's TTS voice coverage is narrower than its text-translation " +
    "coverage — e.g. Fon and Yoruba translate fine but have no TTS voice, which only shows up as a failure at " +
    "call time (there's no reliable way to check in advance). If it fails, say plainly that this language has " +
    "no available voice rather than retrying repeatedly.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to speak" },
      lang: { type: "string", description: 'Language code, e.g. "en", "fr"' },
      outputPath: { type: "string", description: "Path for the output MP3 file" },
    },
    required: ["text", "lang", "outputPath"],
  },
  riskKey: (input) => input.outputPath,
  describeCall: (input) => `speak (${input.lang}) to ${input.outputPath}: ${input.text.slice(0, 60)}${input.text.length > 60 ? "…" : ""}`,
  async handler(input, ctx) {
    if (!isSupported(input.lang)) {
      return { content: `"${input.lang}" isn't a language Google Translate supports at all.`, isError: true };
    }

    let audioBase64: string;
    try {
      audioBase64 = await speak(input.text, { to: input.lang });
    } catch (err) {
      return {
        content: `text_to_speech failed for "${input.lang}": ${err instanceof Error ? err.message : String(err)} — this language likely has no TTS voice available, even though it supports text translation.`,
        isError: true,
      };
    }

    const outputPath = resolveAllowedPath(ctx.cwd, input.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(audioBase64, "base64"));

    return {
      content: `Wrote speech audio to ${input.outputPath}`,
      isError: false,
      media: { kind: "audio", path: input.outputPath, mimeType: "audio/mpeg" },
    };
  },
};
