// Text embeddings via OpenAI's Embeddings API — the same "needs its own
// OPENAI_API_KEY, independent of whichever provider the chat model itself
// uses" pattern as transcribe-audio.ts, since there's no free/keyless
// embeddings service the way text_to_speech has one for TTS.
export interface EmbeddingsConfig {
  apiKey: string;
}

export function embeddingsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig | undefined {
  const apiKey = env.OPENAI_API_KEY;
  return apiKey ? { apiKey } : undefined;
}

const EMBEDDING_MODEL = "text-embedding-3-small";
// OpenAI accepts many inputs per request — batching real embedding calls
// (instead of one request per text) matters here specifically because
// ensureIndexed (session-embeddings-index.ts) can have hundreds of
// not-yet-embedded messages to catch up on the first semantic search.
const MAX_BATCH_SIZE = 96;

interface EmbeddingsResponse {
  data?: { embedding: number[]; index: number }[];
}

interface EmbeddingsErrorResponse {
  error?: { message?: string };
}

/** Embeds one or more texts in as few real API calls as possible, returning vectors in the same order as `texts`. Throws with the real API error message on failure — callers decide how to surface that. */
export async function embedTexts(config: EmbeddingsConfig, texts: string[], apiBaseUrl = "https://api.openai.com/v1"): Promise<number[][]> {
  const results: number[][] = Array.from({ length: texts.length });

  for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
    const batch = texts.slice(start, start + MAX_BATCH_SIZE);
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
      });
    } catch (err) {
      throw new Error(`Failed to reach OpenAI: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = (await response.json()) as EmbeddingsErrorResponse;
        if (data.error?.message) message = data.error.message;
      } catch {
        // Non-JSON error body — fall through with the plain status.
      }
      throw new Error(`Embedding request failed: ${message}`);
    }

    const data = (await response.json()) as EmbeddingsResponse;
    if (!data.data) throw new Error("OpenAI returned an unexpected response shape (no embedding data).");
    for (const item of data.data) results[start + item.index] = item.embedding;
  }

  return results;
}

/** Standard cosine similarity — both OpenAI embedding vectors are already unit-length, but this doesn't assume that. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
