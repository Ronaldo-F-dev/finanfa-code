import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { ensureMessagesEmbedded, searchSessionIndexBySimilarity, resetSessionSearchIndexForTests } from "../../src/core/session-search-index.js";

// Real end-to-end test of the semantic (embeddings-based) half of the
// session index: a real local HTTP server standing in for OpenAI's
// embeddings API (assigning each distinct input text a small deterministic
// vector, so "which messages are semantically closest to the query" can be
// asserted on directly), a real node:sqlite database, and real persisted
// session files.

describe("session-search-index semantic search (real fake embeddings server, real node:sqlite)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let embedRequestCount: number;
  const cwd = "/projects/some-repo";

  // Assigns each distinct text a stable 2D vector by simple content
  // matching, so cosine similarity has an obviously "correct" answer to
  // assert against — a real embeddings model's actual vectors aren't
  // reproducible/predictable enough to build a deterministic test around.
  function vectorFor(text: string): [number, number] {
    if (text.includes("authentication") || text.includes("login")) return [1, 0];
    if (text.includes("garden") || text.includes("tomato")) return [0, 1];
    if (text.includes("JWT") || text.includes("token")) return [0.9, 0.1]; // close to the auth vector, no shared keywords with it
    return [0.5, 0.5];
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        embedRequestCount++;
        const body = JSON.parse(raw) as { input: string[] };
        const data = body.input.map((text, index) => ({ index, embedding: vectorFor(text) }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-search-index-semantic-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    resetSessionSearchIndexForTests();
    embedRequestCount = 0;
  });

  afterEach(async () => {
    resetSessionSearchIndexForTests();
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("finds a semantically related message with no shared keywords with the query", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.title = "Auth refactor";
    s.messages = [
      { role: "user", content: "we should switch to using JWT for the session token" },
      { role: "user", content: "also thinking about when to prune the tomato plants in the garden" },
    ];
    await s.persist();

    // maxResults*5 rows come back before recall-sessions.ts's own
    // per-session top-N cut happens further up the stack — what matters
    // here is the ranking itself, not that a generous result set already
    // excludes the worse match.
    const hits = await searchSessionIndexBySimilarity("login authentication", cwd, 5, { apiKey: "test" }, apiBaseUrl);
    expect(hits[0]?.content).toContain("JWT");
    expect(hits.at(-1)?.content).toContain("tomato"); // clearly the worse match, ranked last
  });

  it("caches embeddings by content — a second call embeds nothing new", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.messages = [{ role: "user", content: "the login page is broken" }];
    await s.persist();

    await ensureMessagesEmbedded({ apiKey: "test" }, apiBaseUrl);
    const afterFirst = embedRequestCount;
    expect(afterFirst).toBeGreaterThan(0);

    await ensureMessagesEmbedded({ apiKey: "test" }, apiBaseUrl);
    expect(embedRequestCount).toBe(afterFirst); // nothing new to embed — no second real request
  });

  it("survives a session's own re-index (new message appended) without re-embedding unchanged content", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.messages = [{ role: "user", content: "the login page is broken" }];
    await s.persist();
    await ensureMessagesEmbedded({ apiKey: "test" }, apiBaseUrl);
    const afterFirst = embedRequestCount;

    // Appending a message and re-persisting changes the file's mtime,
    // which refreshSessionSearchIndex (called by ensureMessagesEmbedded)
    // re-indexes as a whole — deleting and reinserting messages_fts rows
    // for this session, including the unchanged first message. The
    // content-hash-keyed cache must still recognize that first message as
    // already embedded.
    s.messages.push({ role: "assistant", content: "got it, I'll look into the garden situation separately" });
    await s.persist();
    await ensureMessagesEmbedded({ apiKey: "test" }, apiBaseUrl);

    // Only the genuinely new message should have triggered a real embed call.
    expect(embedRequestCount).toBe(afterFirst + 1);
  });
});
