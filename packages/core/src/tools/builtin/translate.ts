import { createApiClient } from "fonika_translate";
import type { ToolDefinition } from "../../core/types.js";

interface TranslateInput {
  text: string;
  to_lang: string;
  from_lang?: string;
}

// The 229Langues backend (fonika_translate's real, Node-usable
// FonikaApiClient — its other exports, FonikaTranslator/createLanguageButtons/
// FonikaSpeechTranslator, are browser-only widgets around the Google
// Translate page script and Web Speech API, unusable from a backend tool)
// needs real credentials the package never reads from the environment on
// its own — the caller has to pass them explicitly. Read once at module
// load, not per call, so a missing config fails the same clear way every
// time instead of a fresh error message shape per attempt.
const AUTH_TOKEN = process.env.FONIKA_AUTH_TOKEN;
const API_TOKEN = process.env.FONIKA_API_TOKEN;
const BASE_URL = process.env.FONIKA_BASE_URL;

/**
 * translate() is typed as Promise<Record<string, unknown>> — fonika_translate
 * itself never documents the response shape (its own README just does
 * `console.log(translated)`), but the 229Langues API's own homepage (GET /,
 * fetched directly by the user, not through this client) documents a
 * envelope every endpoint replies with:
 *   { success: boolean, data: object|array|null, error: string|null, message: string|null }
 * — checked for real error/success fields first (an HTTP 200 with
 * success:false is a real API-level failure, not a translation), then the
 * plausible field names for the actual translated string, first at the top
 * level and then inside `data` (the translate endpoint's own `data` shape
 * isn't spelled out in that documentation, only its request body is).
 * Falls back to the raw JSON rather than silently dropping an unexpected
 * shape — this hasn't been exercised against a real 200 response yet (see
 * the test file's own note on why), so staying defensive here matters.
 */
function extractTranslation(response: Record<string, unknown>): string {
  if (response.success === false) {
    const reason = response.error ?? response.message;
    throw new Error(typeof reason === "string" ? reason : "API reported failure with no error/message field.");
  }
  const candidates: unknown[] = [response];
  if (response.data && typeof response.data === "object") candidates.unshift(response.data as Record<string, unknown>);
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    for (const key of ["translated_text", "translation", "text", "result", "output"]) {
      const value = (candidate as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return JSON.stringify(response);
}

export const translateTextTool: ToolDefinition<TranslateInput> = {
  name: "translate_text",
  description:
    "Translate text between languages via the 229Langues API (fonika_translate) — includes Beninese local " +
    "languages (Fon, Yoruba, Dendi, Bariba) that general web search and the model's own training data cover " +
    "unreliably, in addition to major world languages. Requires FONIKA_AUTH_TOKEN and FONIKA_API_TOKEN to be " +
    "configured (see the README); without them, or if the 229Langues backend itself is unreachable, this " +
    "returns a clear error — say so plainly rather than guessing a translation yourself when that happens, " +
    "since the whole point of this tool is not to rely on the model's own uneven coverage of these languages.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to translate" },
      to_lang: { type: "string", description: 'Target language code, e.g. "en", "fon", "yo"' },
      from_lang: { type: "string", description: "Source language code — omit to let the API detect it" },
    },
    required: ["text", "to_lang"],
  },
  describeCall: (input) => `translate to ${input.to_lang}: ${input.text.slice(0, 60)}${input.text.length > 60 ? "…" : ""}`,
  async handler(input) {
    if (!AUTH_TOKEN || !API_TOKEN) {
      return {
        content:
          "translate_text is not configured — set FONIKA_AUTH_TOKEN and FONIKA_API_TOKEN (a 229Langues account's " +
          "credentials) as environment variables. Optionally set FONIKA_BASE_URL if not using the default backend.",
        isError: true,
      };
    }
    try {
      const api = createApiClient({
        authorizationToken: AUTH_TOKEN,
        apiToken: API_TOKEN,
        ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
      });
      const response = await api.translate({ text: input.text, from_lang: input.from_lang, to_lang: input.to_lang });
      return { content: extractTranslation(response), isError: false };
    } catch (err) {
      return {
        content: `translate_text failed: ${err instanceof Error ? err.message : String(err)} — the 229Langues backend may be unreachable.`,
        isError: true,
      };
    }
  },
};
