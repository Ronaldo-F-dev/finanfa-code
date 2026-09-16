import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";

export interface BedrockModelInfo {
  id: string;
  name?: string;
  /** A plain foundation model id (e.g. "anthropic.claude-sonnet-5-20250929-v1:0") vs a cross-region inference profile id — both are valid values for this project's own `model` config, but only a profile actually works across the regions it lists. */
  kind: "foundation-model" | "inference-profile";
}

export interface ListBedrockModelsOptions {
  region?: string;
  /** Test-only override — a real deployment always wants the real AWS Bedrock control-plane endpoint the SDK resolves from `region`. */
  endpoint?: string;
}

/**
 * Lists the Bedrock foundation models and cross-region inference profiles
 * this account can actually invoke — so a user picking `amazon-bedrock`
 * doesn't have to already know the exact model id string (Bedrock's ids
 * don't match the plain Anthropic ones AmazonBedrockProvider itself takes
 * as `model`) or dig through the AWS console/docs to find it. Uses the
 * same standard AWS credential chain as AmazonBedrockProvider itself
 * (env vars, ~/.aws/credentials, an instance/task role, ...) — no
 * separate credentials of its own.
 */
export async function listBedrockModels(opts: ListBedrockModelsOptions = {}): Promise<BedrockModelInfo[]> {
  const client = new BedrockClient({ region: opts.region, endpoint: opts.endpoint });
  const [foundationModels, inferenceProfiles] = await Promise.all([
    client.send(new ListFoundationModelsCommand({})),
    client.send(new ListInferenceProfilesCommand({})),
  ]);

  const models: BedrockModelInfo[] = [];
  for (const summary of foundationModels.modelSummaries ?? []) {
    if (!summary.modelId) continue;
    models.push({ id: summary.modelId, name: summary.modelName, kind: "foundation-model" });
  }
  for (const summary of inferenceProfiles.inferenceProfileSummaries ?? []) {
    if (!summary.inferenceProfileId) continue;
    models.push({ id: summary.inferenceProfileId, name: summary.inferenceProfileName, kind: "inference-profile" });
  }
  return models;
}
