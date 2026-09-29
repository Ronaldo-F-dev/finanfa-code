# RAG (project document search)

Indexes a project's documents (Markdown, text, PDF, Word, and the other
formats `read_document`'s own document-loader supports) into a local
vector index, so the agent can find a relevant passage by meaning
instead of by filename or exact keyword match — useful when the answer
to a question might be sitting in a spec/design-doc/notes file rather
than in code.

Three agent-facing tools:

| Tool | What it does |
|---|---|
| `index_project_documents` | Builds (or refreshes) the index for a directory (default: the project root). Stores it as a SQLite file at `.finanfa-code/rag-index.sqlite`. Safe to re-run — a document whose content hasn't changed since the last run is skipped without re-embedding. |
| `search_project_documents` | Searches the index for passages relevant to a natural-language query, returning a ranked context block with each passage's source file and character range. |
| `check_claim_grounding` | Embeds a claim/statement and finds the most similar indexed chunk(s), returning a similarity score plus the matched text — a spot-check, not a verdict (see Limitations). |

## Embeddings: zero-config by default

`index_project_documents`/`search_project_documents`/`check_claim_grounding`
all embed through the same default: `Xenova/all-MiniLM-L6-v2`, a small
(~90MB, 384-dim) ONNX model run in-process via `@huggingface/transformers`
— no server, no port, no API key, nothing to configure for a first-time
user. It's lazy-loaded (downloaded/loaded into memory on the first real
embed call, not at startup) and cached under
`~/.finanfa-code/models/transformers`.

To use your own embedding endpoint instead (Ollama's `nomic-embed-text`,
`llama-server --embeddings`, a cloud embeddings API):

```
/config set embeddingApiBaseUrl http://localhost:11434/v1
/config set embeddingModel nomic-embed-text
/config set embeddingApiKey <if the endpoint needs one>
```

Setting `embeddingApiBaseUrl` is what opts into this path — omit it and
the local ONNX model is used, regardless of which provider you've
configured for the main chat model.

## Limitations (read before trusting a score)

This is a similarity search system, not a fact-checker:

- **No true semantic contradiction detection.** `search_project_documents`
  can flag that a query's top results came from more than one distinct
  document (worth a cross-check), but it has no way to compare what those
  documents actually say against each other — it only knows where each
  passage came from, not whether they agree.
- **No certified fact-checking.** `check_claim_grounding` returns a
  cosine-similarity score between a claim and the closest indexed
  chunk(s). A claim can score *high* similarity to a chunk that actually
  contradicts it (similar wording, opposite meaning), and a *true* claim
  can score low if the indexed documents simply don't cover the topic.
  Read the matched text yourself before treating a high or low score as
  confirming or refuting anything.
- **Quality depends on the embedding model.** The zero-config default is
  a small, general-purpose sentence embedding model — good enough for
  finding roughly-relevant passages in typical project docs, not a
  guarantee of ranking quality on specialized/technical text. Pointing
  `embeddingApiBaseUrl` at a stronger embedding model can improve results
  for a given project.

See also [docs/tools.md](tools.md) for where these three tools sit in
the full builtin tool catalog.
