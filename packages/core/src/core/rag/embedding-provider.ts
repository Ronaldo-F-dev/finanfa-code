import path from "node:path";
import os from "node:os";
import { embedTexts } from "../embeddings.js";
import type { FinanfaConfig } from "../config.js";

// Phase 5 of the RAG rollout: turns Phase 4's chunks into vectors. The
// critical constraint (confirmed with the user, not a default anyone should
// second-guess later): finanfa-code must embed with ZERO required config for
// every future user — no separate embedding server to stand up, no GGUF to
// download by hand. So the default path runs a small ONNX model in-process
// via @huggingface/transformers (the actively maintained successor to
// @xenova/transformers — same org, same API), and only a user who explicitly
// sets embeddingApiBaseUrl opts into an external OpenAI-compatible endpoint.

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

const LOCAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const LOCAL_MODEL_DIMENSIONS = 384;

// transformers.js's own type surface is large and its exact shape shifts
// between versions; a narrow structural type for just what's used here
// avoids taking on the whole library's type surface as this module's API.
interface FeatureExtractionPipeline {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<{ tolist(): number[][] }>;
}

/**
 * Zero-config default embedding provider: runs Xenova/all-MiniLM-L6-v2
 * (~90MB, 384-dim) directly in-process via @huggingface/transformers's
 * feature-extraction pipeline — no server, no port, no API key. Mean
 * pooling + L2 normalization is this model's own documented usage (its
 * sentence-transformers model card), not an arbitrary choice.
 *
 * The pipeline is lazy-loaded (the ~90MB model isn't downloaded/loaded
 * until the first real embed() call) and cached on the instance so later
 * calls reuse the same loaded pipeline instead of reloading it.
 */
export class LocalTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = LOCAL_MODEL_DIMENSIONS;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        // Imported dynamically (not a static top-level import) so nothing
        // in this fairly heavy library (onnxruntime, sharp, tokenizers)
        // is even loaded into the process until a first real embed call
        // actually needs it.
        const { pipeline, env } = await import("@huggingface/transformers");
        // Cache the downloaded model under this project's own local-state
        // directory (~/.finanfa-code/), consistent with every other piece
        // of local state finanfa-code keeps there, rather than the
        // library's own default (a hidden dir under $HOME or cwd).
        env.cacheDir = path.join(os.homedir(), ".finanfa-code", "models", "transformers");
        return (await pipeline("feature-extraction", LOCAL_MODEL_ID)) as unknown as FeatureExtractionPipeline;
      })();
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

/**
 * Thin wrapper around the existing embedTexts (embeddings.ts) for the
 * opt-in override path — an OpenAI-compatible embeddings endpoint the user
 * points at explicitly (Ollama's nomic-embed-text, llama-server --embeddings,
 * a cloud provider), fitted to the same EmbeddingProvider shape the local
 * default satisfies so callers above don't need to know which is active.
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly apiBaseUrl: string,
    private readonly model: string | undefined,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return embedTexts({ apiKey: this.apiKey }, texts, this.apiBaseUrl, this.model);
  }
}

// An override endpoint's real dimensionality varies by model (OpenAI's
// text-embedding-3-small is 1536, nomic-embed-text is 768, ...) and isn't
// knowable without an actual call. Rather than guessing wrong, the first
// real embed() response tells VectorStore/Retriever the true dimension;
// this is only ever used as a provisional value before that first call.
const UNKNOWN_DIMENSIONS_PLACEHOLDER = 1536;

/**
 * Picks the embedding provider for the given config: an explicit
 * embeddingApiBaseUrl opts into the override path (a real, user-chosen
 * endpoint); otherwise falls back to the zero-config local default. Every
 * future finanfa-code user gets a working embedding provider with no
 * config at all.
 */
export function createEmbeddingProvider(config: FinanfaConfig): EmbeddingProvider {
  if (config.embeddingApiBaseUrl) {
    return new ApiEmbeddingProvider(
      config.embeddingApiKey ?? config.apiKey ?? "",
      config.embeddingApiBaseUrl,
      config.embeddingModel,
      UNKNOWN_DIMENSIONS_PLACEHOLDER,
    );
  }
  return new LocalTransformersEmbeddingProvider();
}
