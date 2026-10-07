import type { FinanfaConfig } from "./config.js";

// Cloud providers offered in the model picker next to Claude. All three speak the OpenAI chat-completions format, so
// they run through OpenAiCompatibleProvider with their own base URL and key; nothing else about the session changes.
// The model ids are the providers' own; they change over time, so this list is the one place to update them.

export interface CloudProvider {
  id: "deepseek" | "xai" | "gemini";
  label: string;
  baseUrl: string;
  /** Environment variable that overrides the key saved in Settings. */
  envKey: string;
  configKey: "deepseekApiKey" | "xaiApiKey" | "geminiApiKey";
  models: string[];
}

export const CLOUD_PROVIDERS: CloudProvider[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY", configKey: "deepseekApiKey", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { id: "xai", label: "Grok (xAI)", baseUrl: "https://api.x.ai/v1", envKey: "XAI_API_KEY", configKey: "xaiApiKey", models: ["grok-4", "grok-code-fast-1"] },
  {
    id: "gemini",
    label: "Gemini (Google)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    configKey: "geminiApiKey",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
];

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** The cloud provider whose base URL this is, if any (a detected local model never matches). */
export function cloudProviderForBaseUrl(baseUrl: string | undefined): CloudProvider | undefined {
  if (!baseUrl) return undefined;
  return CLOUD_PROVIDERS.find((p) => trimSlash(p.baseUrl) === trimSlash(baseUrl));
}

export function cloudApiKey(provider: CloudProvider, config: FinanfaConfig): string | undefined {
  return process.env[provider.envKey] || config[provider.configKey] || undefined;
}
