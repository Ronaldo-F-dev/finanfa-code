import type { ToolDefinition } from "../../core/types.js";
import type { FinanfaConfig } from "../../core/config.js";
import { listBedrockModels } from "../../providers/bedrock-models.js";

/**
 * Lists the models actually available to call with the project's
 * configured provider account. Currently only amazon-bedrock has a real,
 * queryable API for this (ListFoundationModels/ListInferenceProfiles —
 * see bedrock-models.ts); every other provider here (Anthropic, Cohere,
 * Gemini, Azure OpenAI, an OpenAI-compatible endpoint) publishes a fixed
 * model list in its own docs instead of exposing a live discovery
 * endpoint — Google Vertex AI in particular was checked against its real
 * `@google-cloud/aiplatform` SDK: `ModelGardenServiceClient` only has
 * `getPublisherModel` (fetch one exact, already-known model id), no
 * `listPublisherModels` equivalent, so there's genuinely nothing to
 * implement there yet.
 */
export function createListAvailableModelsTool(config: FinanfaConfig): ToolDefinition<Record<string, never>> {
  return {
    name: "list_available_models",
    description:
      "Lists the models actually available to call with the project's configured provider account. Only " +
      'supported for provider "amazon-bedrock" today — every other provider publishes a fixed model list in ' +
      "its own docs rather than exposing a live discovery API. Returns a clear error naming the active provider " +
      "otherwise, instead of guessing.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list available models",
    async handler() {
      const provider = process.env.FINANFA_PROVIDER ?? config.provider ?? "anthropic";
      if (provider !== "amazon-bedrock") {
        return {
          content: `Model discovery isn't available for provider "${provider}" — only amazon-bedrock exposes a live API for this today. Check that provider's own documentation for its current model list.`,
          isError: true,
        };
      }

      const region = process.env.FINANFA_AWS_REGION ?? config.awsRegion;
      try {
        const models = await listBedrockModels({ region });
        if (models.length === 0) return { content: "No models found for this AWS account/region.", isError: false };
        const lines = models.map((m) => `${m.id}${m.name ? ` — ${m.name}` : ""} (${m.kind})`);
        return { content: lines.join("\n"), isError: false };
      } catch (err) {
        return { content: `Failed to list Bedrock models: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
