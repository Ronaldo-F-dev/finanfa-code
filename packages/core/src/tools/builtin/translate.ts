import { createApiClient } from "fonika_translate";
import googleTranslate, { isSupported as isSupportedByGoogle } from "google-translate-api-x";
import type { ToolDefinition } from "../../core/types.js";

interface TranslateInput {
  text: string;
  to_lang: string;
  from_lang?: string;
}

// 229Langues (fonika_translate's FonikaApiClient — its other exports,
// FonikaTranslator/createLanguageButtons/FonikaSpeechTranslator, are
// browser-only widgets around the Google Translate page script and Web
// Speech API, unusable from a backend tool) is a private, invite-only
// backend — not something a finanfa-code install can reach out of the box,
// confirmed directly: the default URL 404s from every angle except the
// account owner's own authenticated browser. Read once at module load, not
// per call, so a missing config fails the same clear way every time.
const AUTH_TOKEN = process.env.FONIKA_AUTH_TOKEN;
const API_TOKEN = process.env.FONIKA_API_TOKEN;
const BASE_URL = process.env.FONIKA_BASE_URL;
const FONIKA_CONFIGURED = Boolean(AUTH_TOKEN && API_TOKEN);

/**
 * Every 229Langues endpoint replies inside a
 * { success, data, error, message } envelope (documented on the API's own
 * homepage) — checked first (an HTTP 200 with success:false is a real API
 * failure, not a translation), then the plausible field names for the
 * translated string, at the top level and inside `data` (the translate
 * endpoint's own `data` shape isn't spelled out in that documentation,
 * only its request body is — this hasn't been exercised against a real
 * response yet, since the backend needs the owner's own credentials).
 */
function extractFonikaTranslation(response: Record<string, unknown>): string {
  if (response.success === false) {
    const reason = response.error ?? response.message;
    throw new Error(typeof reason === "string" ? reason : "229Langues API reported failure with no error/message field.");
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

async function translateViaFonika(input: TranslateInput): Promise<string> {
  const api = createApiClient({
    authorizationToken: AUTH_TOKEN!,
    apiToken: API_TOKEN!,
    ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
  });
  const response = await api.translate({ text: input.text, from_lang: input.from_lang, to_lang: input.to_lang });
  return extractFonikaTranslation(response);
}

/**
 * The free, no-signup default — google-translate-api-x mirrors the same
 * translate.google.com the consumer web UI uses (not the paid Cloud
 * Translation API, which has a much more conservative language list), so
 * it picked up the ~110 languages Google added in 2024, Fon included.
 * Verified directly, not assumed from the language existing in its
 * generated list: a real "Bonjour, comment allez-vous ?" call returned
 * real Fon orthography ("Kudo zanzan‚ nε mi ɖe gbɔn ?", correct ɖ/ε
 * characters) and round-tripped back through Fon→French correctly.
 * Bariba and Dendi are not in Google Translate at all (isSupported()
 * returns false for both, checked directly) — there is currently no free
 * or paid backend for either.
 */
async function translateViaGoogle(input: TranslateInput): Promise<string> {
  if (!isSupportedByGoogle(input.to_lang) || (input.from_lang && !isSupportedByGoogle(input.from_lang))) {
    throw new Error(
      `"${isSupportedByGoogle(input.to_lang) ? input.from_lang : input.to_lang}" isn't a language Google Translate supports ` +
        "(this notably includes Bariba and Dendi — no free or paid translation backend covers either right now).",
    );
  }
  const result = await googleTranslate(input.text, { from: input.from_lang || "auto", to: input.to_lang });
  return Array.isArray(result) ? result.map((r) => r.text).join("\n") : result.text;
}

export const translateTextTool: ToolDefinition<TranslateInput> = {
  name: "translate_text",
  description:
    "Translate text between languages. Uses the free Google Translate backend by default — no configuration " +
    "needed, and it includes Fon and Yoruba (Beninese local languages the model's own training data and web " +
    "search both cover unreliably) alongside major world languages; Bariba and Dendi aren't supported by any " +
    "backend currently. If FONIKA_AUTH_TOKEN/FONIKA_API_TOKEN (a private 229Langues account) are configured, " +
    "that's tried first and Google Translate is the fallback. Say plainly when a language genuinely isn't " +
    "supported rather than guessing a translation yourself.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to translate" },
      to_lang: { type: "string", description: 'Target language code, e.g. "en", "fon", "yo"' },
      from_lang: { type: "string", description: "Source language code — omit to auto-detect" },
    },
    required: ["text", "to_lang"],
  },
  describeCall: (input) => `translate to ${input.to_lang}: ${input.text.slice(0, 60)}${input.text.length > 60 ? "…" : ""}`,
  async handler(input) {
    const errors: string[] = [];
    if (FONIKA_CONFIGURED) {
      try {
        return { content: await translateViaFonika(input), isError: false };
      } catch (err) {
        errors.push(`229Langues: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      return { content: await translateViaGoogle(input), isError: false };
    } catch (err) {
      errors.push(`Google Translate: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { content: `translate_text failed.\n${errors.join("\n")}`, isError: true };
  },
};
