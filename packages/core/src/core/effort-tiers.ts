// Curated "effort" presets — a shortcut past manually picking a model,
// tuning its max_tokens, and remembering to strip most tools every time a
// small/local model is chosen. Real, reported crash pattern this exists to
// fix: the same ~40k-token system-prompt-plus-tool-list overhead was sent
// to every local model regardless of its own context window, and at least
// one installed model (yi-coder) doesn't support tool calling at all —
// sending it a tool list failed outright. Each tier below is deliberately
// matched to what its model can actually handle, verified against the real
// Ollama instance in this environment (see EFFORT_TIERS' own per-tier
// comments) rather than picked by name/size alone.

export type EffortLevel = "low" | "medium" | "high" | "legal";

/** Which of this project's own tool names stay enabled for a tier — everything else is disabled the same way the web UI's Tools panel would. "none" sends no tools field at all (see toolsForProvider/streamTurn), which is required for a model with no tool-calling support, not just a size optimization. */
export type ToolBudget = "none" | "minimal" | "full";

/** The safe, high-value core every "minimal" tier keeps: enough to read/search/edit a codebase, nothing that shells out or reaches the network — keeps the tool-list JSON small (a few hundred tokens instead of tens of thousands) without leaving the model unable to do real work. */
export const MINIMAL_TOOL_SET = ["read_file", "write_file", "edit_file", "glob", "grep"];

export interface EffortTier {
  id: EffortLevel;
  label: string;
  description: string;
  /** Model id as the provider expects it — for a local tier, the exact Ollama tag (e.g. "qwen3:4b-instruct"). Empty for the "high" tier — see isDefaultProviderTier. */
  model: string;
  /** Undefined for the "high" tier, which deliberately has no fixed family of its own — see isDefaultProviderTier. */
  family?: "openai-compatible" | "anthropic";
  /** Set only for a local tier — the same detected-local-runtime baseUrl override the model picker already sends on set_model. Undefined selects whatever provider is configured as the project/global default (Poolside/Anthropic/...). */
  baseUrl?: string;
  /** Ollama model name to check for / offer to pull when this tier is picked and the model isn't installed yet — undefined for the cloud tier, which needs no local download. */
  ollamaModel?: string;
  maxTokens: number;
  toolBudget: ToolBudget;
}

const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export const EFFORT_TIERS: EffortTier[] = [
  {
    id: "low",
    label: "Faible",
    // Swapped from yi-coder:1.5b-chat after a real side-by-side: gemma2:2b
    // gave noticeably warmer, more natural French chat responses in a
    // direct comparison (see the "chat only" use case this tier targets —
    // it's picked for conversation quality, not coding). Same underlying
    // reason for toolBudget "none" as before: gemma2:2b's own Ollama
    // /api/tags capabilities are ["completion"] only, no "tools" — sending
    // it a tool list fails outright regardless of how many are in it.
    description: "Réponses rapides, sans outils — gemma2:2b (aucun tool calling, donc aucun outil envoyé : c'est ce qui évite le crash déjà rencontré avec ce type de modèle). Bon pour la conversation en français.",
    model: "gemma2:2b",
    family: "openai-compatible",
    baseUrl: OLLAMA_BASE_URL,
    ollamaModel: "gemma2:2b",
    maxTokens: 512,
    toolBudget: "none",
  },
  {
    id: "medium",
    label: "Moyen",
    description: "Un modèle local qui supporte les outils (lecture/édition de fichiers) avec un jeu d'outils réduit — qwen3:4b-instruct.",
    model: "qwen3:4b-instruct",
    family: "openai-compatible",
    baseUrl: OLLAMA_BASE_URL,
    ollamaModel: "qwen3:4b-instruct",
    maxTokens: 2048,
    toolBudget: "minimal",
  },
  {
    id: "high",
    label: "Fort",
    description: "Le modèle cloud par défaut du projet (ex: Poolside/laguna, ou Claude), avec tous les outils — pour les tâches complexes.",
    model: "",
    maxTokens: 8192,
    toolBudget: "full",
  },
  {
    id: "legal",
    label: "Juridique",
    // SaulLM-7B-Instruct (Equall, MIT) — a real, open, domain-specific
    // legal LLM, not a general model asked to "act like a lawyer". Pulled
    // via Ollama's HuggingFace GGUF support (no official ollama.com/library
    // entry for it). Verified directly against this project's own Ollama
    // instance: capabilities are ["completion"] only, same as gemma2/
    // yi-coder — a domain fine-tune of Mistral-7B, no tool-calling
    // training — so toolBudget "none" for the same reason as the "low"
    // tier. Its training corpus is primarily English/US-UK/EU case law,
    // not French law specifically — real-tested with a French legal
    // question and got a coherent, on-topic (if imperfect) answer, but
    // that mismatch is worth knowing, not hidden.
    description:
      "SaulLM-7B — modèle spécialisé droit (Equall, licence MIT), aucun tool calling. Corpus principalement anglo-saxon (UK/US/UE), " +
      "testé en français avec des réponses cohérentes mais pas natif du droit français. Réponses lentes (>1min) sur CPU.",
    model: "hf.co/MaziyarPanahi/Saul-Instruct-v1-GGUF:Q4_K_M",
    family: "openai-compatible",
    baseUrl: OLLAMA_BASE_URL,
    ollamaModel: "hf.co/MaziyarPanahi/Saul-Instruct-v1-GGUF:Q4_K_M",
    maxTokens: 1024,
    toolBudget: "none",
  },
];

/** The "high" tier deliberately has no fixed model/family of its own — it means "use whatever this project/global config already has configured as its default provider" (Poolside via openai-compatible, Anthropic, ...), not a specific hardcoded one. Callers must resolve both `model` and `family` against the caller's own default (e.g. selectProvider's {defaultModel, kind}) instead of this tier's own (empty/undefined) fields. */
export function isDefaultProviderTier(tier: EffortTier): boolean {
  return tier.id === "high";
}

export function getEffortTier(id: string): EffortTier | undefined {
  return EFFORT_TIERS.find((t) => t.id === id);
}
