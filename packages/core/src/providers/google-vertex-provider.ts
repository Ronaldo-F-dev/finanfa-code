import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../core/types.js";
import { streamAnthropicTurn } from "./anthropic-provider.js";

// Claude models via Google Cloud Vertex AI — same Messages API request/
// response shape as the direct Anthropic API (see streamAnthropicTurn),
// authenticated with Google Application Default Credentials instead of an
// Anthropic API key. `params.model` is the Vertex publisher model ID
// (e.g. "claude-sonnet-5@20250929"), not a plain Anthropic model name.
export interface GoogleVertexProviderOptions {
  /** Defaults to the CLOUD_ML_REGION env var — there's no other fallback, unlike Bedrock's region default. */
  region?: string;
  /**
   * The GCP project to bill/run against. Defaults to the
   * ANTHROPIC_VERTEX_PROJECT_ID env var, or whatever the resolved
   * credentials themselves carry (e.g. a service account's own project).
   */
  projectId?: string;
}

export class GoogleVertexProvider implements LlmProvider {
  private readonly client: AnthropicVertex;

  constructor(opts: GoogleVertexProviderOptions = {}) {
    this.client = new AnthropicVertex({ region: opts.region, projectId: opts.projectId });
  }

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    return streamAnthropicTurn(this.client, params);
  }
}
