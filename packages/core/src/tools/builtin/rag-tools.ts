import type { ToolDefinition } from "../../core/types.js";
import type { FinanfaConfig } from "../../core/config.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../../core/rag/embedding-provider.js";
import { Retriever } from "../../core/rag/retriever.js";
import { VectorStore } from "../../core/rag/vector-store.js";
import { buildContext } from "../../core/rag/context-builder.js";

// Phase 7 of the RAG rollout: exposes phases 4-6 (document-loader/chunker/
// embedding-provider/vector-store/retriever/context-builder) to the agent
// as two real tools. No citation/contradiction-handling here (phase 8) —
// buildContext's per-chunk source path already carries that, which is
// enough for this phase.
//
// Phase 8 adds a third tool (check_claim_grounding) plus a structural
// "multiple sources" note on search_project_documents' output. Both are
// deliberately narrow: a real similarity signal and a real structural
// observation, neither dressed up as semantic contradiction detection or a
// certified fact-check — see each one's description/comment for why.

/**
 * A distinct source counts as "meaningfully" relevant, for the multi-source
 * note below, at score > 0 — the only threshold this codebase actually
 * grounds in what these scores mean (retriever.ts's own DEFAULT_MIN_SCORE
 * comment: negative cosine similarity is "never a genuine match", and no
 * fixed positive cutoff like 0.5 is safe to invent since "relevant"
 * similarity varies by embedding model). Anything already at or below 0
 * isn't a genuine match at all, so it can't count toward "another source
 * also answered this".
 */
const MEANINGFUL_RELEVANCE_FLOOR = 0;

interface IndexProjectDocumentsInput {
  /** Directory to scan for documents. Defaults to the project root (the session's cwd) if omitted. */
  directory?: string;
}

function formatIndexSummary(summary: {
  documentsIndexed: number;
  documentsSkipped: number;
  documentsFailed: number;
  chunksIndexed: number;
  failures: { path: string; reason: string }[];
}): string {
  const lines = [
    `Indexed ${summary.documentsIndexed} document(s) (${summary.chunksIndexed} chunk(s)), ` +
      `skipped ${summary.documentsSkipped} unchanged, ${summary.documentsFailed} failed.`,
  ];
  if (summary.failures.length > 0) {
    lines.push("Failures:");
    for (const f of summary.failures) lines.push(`  ${f.path}: ${f.reason}`);
  }
  return lines.join("\n");
}

/**
 * `provider`, when given, lets createRagTools below share a single
 * EmbeddingProvider with search_project_documents instead of each tool
 * loading its own — its pipeline is lazy-loaded and cached on the
 * instance (see LocalTransformersEmbeddingProvider), so reusing one
 * instance means the ~90MB local model is loaded at most once per
 * process no matter which tool is called first or how many times either
 * is called after that. Omitted, a fresh provider resolved from `config`
 * is used instead (e.g. for constructing this tool on its own in a test).
 * A Retriever, by contrast, is cheap to construct per call — VectorStore
 * caches its underlying SQLite handle by cwd at module level
 * (vector-store.ts's own openDbs map), so `new Retriever(cwd, provider)`
 * does no real work beyond that cache lookup.
 */
export function createIndexProjectDocumentsTool(config: FinanfaConfig, provider: EmbeddingProvider = createEmbeddingProvider(config)): ToolDefinition<IndexProjectDocumentsInput> {
  return {
    name: "index_project_documents",
    description:
      "Builds (or refreshes) a local search index over this project's documents (Markdown, text, PDF, Word, " +
      "and other formats document-loader supports) so search_project_documents can find relevant passages by " +
      "meaning, not just filename. Stores the index as a SQLite file under .finanfa-code/rag-index.sqlite in " +
      "the indexed project. Safe to re-run any time, a document whose content hasn't changed since the last " +
      "run is skipped without re-embedding, so a second run over an unchanged project is cheap. The first run " +
      "over a real document set does real embedding work (a real, if modest, cost) and downloads a small local " +
      "embedding model on its very first use process-wide.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to index. Defaults to the project root if omitted." },
      },
    },
    describeCall: (input) => `index project documents${input.directory ? ` in ${input.directory}` : ""}`,
    async handler(input, ctx) {
      const directory = input.directory ?? ctx.cwd;
      // The index itself always lives under the session's own project root
      // (ctx.cwd), even when `directory` points at a subdirectory to scan —
      // same project, same index, matching how VectorStore is scoped.
      const retriever = new Retriever(ctx.cwd, provider);
      let summary;
      try {
        summary = await retriever.indexProject(directory);
      } catch (err) {
        return { content: `Failed to index "${directory}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      return { content: formatIndexSummary(summary), isError: false, metadata: { summary } };
    },
  };
}

interface SearchProjectDocumentsInput {
  query: string;
  /** Max number of chunks to return. Default 8. */
  topK?: number;
}

/** See createIndexProjectDocumentsTool's `provider` param doc — same sharing rationale applies here. */
export function createSearchProjectDocumentsTool(config: FinanfaConfig, provider: EmbeddingProvider = createEmbeddingProvider(config)): ToolDefinition<SearchProjectDocumentsInput> {
  return {
    name: "search_project_documents",
    description:
      "Searches this project's indexed documents (via index_project_documents) for passages relevant to a " +
      "natural-language query, returning a formatted context block ranked by relevance with each passage's " +
      "source file and character range. Use this instead of grep/read_file to answer a question that might be " +
      "covered in project docs/specs/notes rather than code, it matches by meaning, so it can find a relevant " +
      "passage with none of the query's exact words. Returns a clear message if nothing has been indexed yet.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question or topic to search for" },
        topK: { type: "number", description: "Max number of chunks to return (default 8)" },
      },
      required: ["query"],
    },
    describeCall: (input) => `search project documents for "${input.query}"`,
    async handler(input, ctx) {
      const vectorStore = new VectorStore(ctx.cwd);
      if (vectorStore.listDocuments().length === 0) {
        return {
          content: "No documents have been indexed in this project yet. Run index_project_documents first, then search again.",
          isError: false,
        };
      }

      const retriever = new Retriever(ctx.cwd, provider);
      const chunks = await retriever.retrieve(input.query, { topK: input.topK });
      if (chunks.length === 0) {
        return { content: `No indexed document matched "${input.query}".`, isError: false };
      }

      const built = buildContext(chunks);
      const truncatedNote = built.truncated
        ? "\n\n(Some additional, lower-relevance matches were left out to stay within the context budget.)"
        : "";
      const multiSourceNote = formatMultiSourceNote(built.includedChunks);
      return {
        content: built.text + truncatedNote + multiSourceNote,
        isError: false,
        metadata: { includedChunks: built.includedChunks.length, truncated: built.truncated },
      };
    },
  };
}

/**
 * Structural signal, not contradiction detection: if the results actually
 * shown span more than one distinct source document (each with a genuine,
 * positive-relevance chunk — see MEANINGFUL_RELEVANCE_FLOOR), that means
 * multiple independent documents answered this query, which is worth a
 * cross-check. It does NOT mean the documents disagree — this system has no
 * way to compare the chunks' meaning against each other, only where they
 * came from — so the note says exactly that, not more.
 */
function formatMultiSourceNote(chunks: { sourcePath: string; score: number }[]): string {
  const distinctSources = [...new Set(chunks.filter((c) => c.score > MEANINGFUL_RELEVANCE_FLOOR).map((c) => c.sourcePath))];
  if (distinctSources.length < 2) return "";
  return (
    `\n\n(Results came from ${distinctSources.length} different documents: ${distinctSources.join(", ")}, ` +
    "this only means multiple independent sources answered the query, not that they disagree. If they cover " +
    "the same point, check both before treating either as authoritative.)"
  );
}

interface CheckClaimGroundingInput {
  claim: string;
  /** Max number of matched chunks to return. Default 3. */
  topK?: number;
}

/** See createIndexProjectDocumentsTool's `provider` param doc — same sharing rationale applies here. */
export function createCheckClaimGroundingTool(config: FinanfaConfig, provider: EmbeddingProvider = createEmbeddingProvider(config)): ToolDefinition<CheckClaimGroundingInput> {
  return {
    name: "check_claim_grounding",
    description:
      "Spot-checks a claim/statement against this project's indexed documents (via index_project_documents) by " +
      "embedding the claim with the same embedding model the documents were indexed with and finding the most " +
      "similar indexed chunk(s), returning a similarity score (the same cosine-similarity scale " +
      "search_project_documents uses) plus each match's source and text. " +
      "This is a similarity signal, NOT a fact-checker or a grounding guarantee: a claim can score high " +
      "similarity to a chunk that actually contradicts it (similar wording, opposite meaning), and a claim can " +
      "be true but still score low if the indexed documents simply don't cover it. Use it to spot-check a key " +
      "claim before asserting it confidently, not as a verdict, read the matched text yourself before treating " +
      "a high or low score as confirming or refuting the claim.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "The claim or statement to check against indexed documents" },
        topK: { type: "number", description: "Max number of matched chunks to return (default 3)" },
      },
      required: ["claim"],
    },
    describeCall: (input) => `check grounding for claim "${input.claim}"`,
    async handler(input, ctx) {
      const vectorStore = new VectorStore(ctx.cwd);
      if (vectorStore.listDocuments().length === 0) {
        return {
          content: "No documents have been indexed in this project yet. Run index_project_documents first, then check grounding again.",
          isError: false,
        };
      }

      const retriever = new Retriever(ctx.cwd, provider);
      const chunks = await retriever.retrieve(input.claim, { topK: input.topK ?? 3 });
      if (chunks.length === 0) {
        return {
          content:
            `No indexed chunk is even weakly similar to "${input.claim}", either this project's documents don't ` +
            "cover this topic at all, or the claim is genuinely unrelated to anything indexed. A low/no score here " +
            "doesn't mean the claim is false, only that the index doesn't speak to it either way.",
          isError: false,
        };
      }

      const built = buildContext(chunks);
      const limitationNote =
        "\n\n(Similarity signal only, not a fact-check: a high score can still mean the best match contradicts " +
        "the claim in meaning despite similar wording, and a true claim can score low if the index just doesn't " +
        "cover it. Read the matched text above before treating this score as confirming or refuting the claim.)";
      return {
        content: built.text + limitationNote,
        isError: false,
        metadata: { bestScore: chunks[0]?.score, includedChunks: built.includedChunks.length },
      };
    },
  };
}

/** Registered together so all three tools share one EmbeddingProvider instance (see createIndexProjectDocumentsTool's `provider` param doc). */
export function createRagTools(config: FinanfaConfig): ToolDefinition<any>[] {
  const provider = createEmbeddingProvider(config);
  return [
    createIndexProjectDocumentsTool(config, provider),
    createSearchProjectDocumentsTool(config, provider),
    createCheckClaimGroundingTool(config, provider),
  ];
}
