import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../core/types.js";
import { streamAnthropicTurn } from "./anthropic-provider.js";

// Claude models via Amazon Bedrock — same Messages API request/response
// shape as the direct Anthropic API (see streamAnthropicTurn), just
// signed with AWS SigV4 and billed through AWS instead of an Anthropic API
// key. `params.model` is a Bedrock model ID (e.g.
// "anthropic.claude-sonnet-5-20250929-v1:0") or a cross-region inference
// profile ARN, not a plain Anthropic model name.
export interface AmazonBedrockProviderOptions {
  /** Defaults to the AWS_REGION env var, then "us-east-1" — same default the AWS CLI/SDK use. */
  region?: string;
  /**
   * Static credentials, for the rare case the standard AWS credential
   * chain (env vars, ~/.aws/credentials, an instance/task role, ...)
   * isn't what should be used here. Leave unset to use that chain — the
   * same way `aws` CLI commands already authenticate on this machine.
   */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export class AmazonBedrockProvider implements LlmProvider {
  private readonly client: AnthropicBedrock;

  constructor(opts: AmazonBedrockProviderOptions = {}) {
    this.client =
      opts.accessKeyId && opts.secretAccessKey
        ? new AnthropicBedrock({
            awsRegion: opts.region,
            awsAccessKey: opts.accessKeyId,
            awsSecretKey: opts.secretAccessKey,
            awsSessionToken: opts.sessionToken,
          })
        : new AnthropicBedrock({ awsRegion: opts.region });
  }

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    return streamAnthropicTurn(this.client, params);
  }
}
