// Phase 2 of the local-first, multi-model architecture (see project memory
// for the full roadmap): a shared vocabulary for "what a model is used for",
// so a text-only 1.7B default doesn't get asked to do vision or image
// generation just because it's the only model configured. Kept as a small,
// standalone module — everything downstream (selectProvider,
// selectVisionProvider, a future image-generation/embedding resolver)
// imports from here rather than each inventing its own capability naming.
export type ModelCapability = "text" | "vision" | "image_generation" | "embedding";

/**
 * Every one of these backends speaks the same OpenAI chat-completions wire
 * format that OpenAiCompatibleProvider already implements — llama.cpp's
 * server, Ollama, LM Studio, vLLM, MLX's own OpenAI-compatible server mode,
 * and OpenRouter all expose /v1/chat/completions. Rather than one near-
 * duplicate provider class per backend name, TEXT_MODEL_PROVIDER/
 * VISION_MODEL_PROVIDER (etc.) accept these friendlier names and this maps
 * them onto the single "openai-compatible" kind selectProvider/
 * selectVisionProvider already know how to build. Unrecognized values pass
 * through unchanged (covers "anthropic", "azure-openai", "gemini",
 * "amazon-bedrock", "github-copilot", "cohere", "google-vertex", and any
 * future kind added directly to selectProvider without needing a matching
 * entry here).
 */
const OPENAI_COMPATIBLE_ALIASES = new Set(["llama_cpp", "llama.cpp", "mlx", "ollama", "lmstudio", "lm-studio", "vllm", "openrouter"]);

export function resolveProviderKindAlias(kind: string): string {
  return OPENAI_COMPATIBLE_ALIASES.has(kind) ? "openai-compatible" : kind;
}
