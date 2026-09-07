import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle, compactSession } from "@finanfa/core/src/core/loop.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { McpClientManager, MCP_TOOL_PREFIX } from "@finanfa/core/src/mcp/client-manager.js";
import { loadMcpServers } from "@finanfa/core/src/mcp/config.js";
import { MCP_CATALOG } from "./mcp-catalog.js";
import { loadSkills, formatSkillIndex, createReadSkillTool, writeSkill, deleteSkill } from "@finanfa/core/src/skills/loader.js";
import {
  loadMemories,
  formatMemoryIndex,
  createReadMemoryTool,
  writeMemoryTool,
  writeMemory,
  deleteMemory,
  type MemoryType,
} from "@finanfa/core/src/memory/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig, saveGlobalConfig, type FinanfaConfig } from "@finanfa/core/src/core/config.js";
import { CONFIG_KEYS, SECRET_KEYS, maskSecret } from "@finanfa/core/src/commands/builtin.js";
import { BASE_SYSTEM_PROMPT, selectProvider, connectMcpServers, parseApiKeys } from "@finanfa/core/src/app.js";
import { detectLocalProviders } from "@finanfa/core/src/core/local-providers.js";
import { AnthropicProvider } from "@finanfa/core/src/providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "@finanfa/core/src/providers/openai-compatible-provider.js";
import type { LlmProvider, NeutralImage } from "@finanfa/core/src/core/types.js";
import { PRICING } from "@finanfa/core/src/core/pricing.js";
import { createWebUiAdapter } from "./web-ui-adapter.js";
import { resolveAllowedPath } from "@finanfa/core/src/tools/builtin/path-guard.js";
import { mkdir, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import JSZip from "jszip";
import {
  DEFAULT_PROJECT_ID,
  listProjects,
  createProject,
  deleteProject,
  resolveProjectDir,
  projectExists,
} from "./projects.js";

// The workspace the "default" project points at — the same "cwd" concept as
// running the CLI from that directory, and the only workspace that existed
// before Projects did (kept working unchanged for anyone not using Projects
// at all). Every other project is a real directory under
// projects.ts's PROJECTS_ROOT, picked per-connection/per-request below.
const DEFAULT_CWD = process.env.FINANFA_WEB_CWD ?? process.cwd();
const PORT = Number(process.env.PORT ?? 4600);

const app = express();
app.use(express.json({ limit: "25mb" })); // images arrive as base64 JSON — comfortably over a typical photo's encoded size

/** Resolves a `?project=` query param to a real, validated directory — 404s (via the thrown error's message) rather than silently falling back, so a stale/deleted project id in the URL surfaces clearly instead of quietly operating on the wrong workspace. */
async function resolveCwd(projectId: string | undefined): Promise<string> {
  const id = projectId || DEFAULT_PROJECT_ID;
  if (!(await projectExists(id))) throw new Error(`Unknown project "${id}".`);
  return resolveProjectDir(id, DEFAULT_CWD);
}

const EXCLUDED_DIRS = new Set([".finanfa-code", "node_modules", ".git"]);

async function addDirToZip(zip: JSZip, dir: string, prefix: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDirToZip(zip, full, zipPath);
    else zip.file(zipPath, await readFile(full));
  }
}

type ProviderFamily = "anthropic" | "openai-compatible";

/**
 * Whether enough config/env is present to actually construct each provider
 * family — used to flag an unconfigured model in the picker before the user
 * even tries it. config.apiKey is a single field reused for whichever
 * family config.provider currently names (same as selectProvider/the CLI's
 * /config) — it must NOT be read as "an Anthropic key" while the saved
 * provider is actually "openai-compatible" (it'd be that provider's key),
 * or every model would show as configured off of an unrelated secret.
 */
async function familyAvailability(config: FinanfaConfig): Promise<Record<ProviderFamily, boolean>> {
  const savedFamily: ProviderFamily = config.provider === "openai-compatible" ? "openai-compatible" : "anthropic";
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(config.anthropicApiKey) || (savedFamily === "anthropic" && Boolean(config.apiKey)),
    "openai-compatible": Boolean(process.env.FINANFA_BASE_URL) || (savedFamily === "openai-compatible" && Boolean(config.baseUrl)),
  };
}

/** Only called after familyAvailability confirms `family`, so config.apiKey/baseUrl are only read here when they actually belong to it (see familyAvailability's own note on the shared-field ambiguity). */
function buildProvider(family: ProviderFamily, config: FinanfaConfig): LlmProvider {
  const savedFamily: ProviderFamily = config.provider === "openai-compatible" ? "openai-compatible" : "anthropic";
  if (family === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey ?? (savedFamily === "anthropic" ? config.apiKey : undefined);
    return new AnthropicProvider(apiKey);
  }
  const baseUrl = process.env.FINANFA_BASE_URL ?? (savedFamily === "openai-compatible" ? config.baseUrl : undefined);
  if (!baseUrl) throw new Error("openai-compatible requires a base URL — checked by the caller via familyAvailability first.");
  const apiKey = process.env.FINANFA_API_KEY ?? (savedFamily === "openai-compatible" ? config.apiKey : undefined);
  const apiKeys = parseApiKeys(process.env.FINANFA_API_KEYS) ?? (savedFamily === "openai-compatible" ? config.apiKeys : undefined);
  return new OpenAiCompatibleProvider({ baseUrl, apiKey, apiKeys });
}

app.get("/api/models", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const config = await loadConfig(cwd);
  const { defaultModel, kind } = selectProvider(config);
  const availability = await familyAvailability(config);
  // Zero-config local runtimes (Ollama, LM Studio, ...) — probed fresh on
  // every call rather than cached, since the whole point is reflecting
  // what's actually running right now (a model pulled/unloaded since the
  // last check). Each carries its own baseUrl because, unlike the single
  // configured openai-compatible entry below, there can be several of these
  // at once, each needing a different endpoint.
  const localModels = await detectLocalProviders();
  const models = [
    ...Object.keys(PRICING).map((id) => ({ id, family: "anthropic" as const, configured: availability.anthropic })),
    // The openai-compatible "family" is really just whatever single model the
    // user configured — there's no fixed catalog for an arbitrary self-hosted
    // endpoint (Ollama/OpenRouter/Poolside/...), unlike Anthropic's fixed lineup.
    ...(availability["openai-compatible"] && defaultModel && kind === "openai-compatible"
      ? [{ id: defaultModel, family: "openai-compatible" as const, configured: true }]
      : []),
    ...localModels.map((m) => ({ id: `${m.source}: ${m.id}`, family: "openai-compatible" as const, configured: true, baseUrl: m.baseUrl, localModelId: m.id })),
  ];
  res.json({ activeProviderKind: kind, defaultModel, models });
});

app.post("/api/upload", async (req, res) => {
  const { filename, dataBase64, project } = req.body as { filename?: string; dataBase64?: string; project?: string };
  if (!filename || !dataBase64) {
    res.status(400).json({ error: "filename and dataBase64 are required" });
    return;
  }
  const cwd = await resolveCwd(project).catch(() => DEFAULT_CWD);
  const uploadDir = path.join(cwd, ".finanfa-code", "uploads");
  await mkdir(uploadDir, { recursive: true });
  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const fullPath = path.join(uploadDir, safeName);
  await writeFile(fullPath, Buffer.from(dataBase64, "base64"));
  res.json({ path: fullPath });
});

app.get("/api/sessions", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const sessions = await AgentSession.list(cwd);
  res.json({ sessions: sessions.map((s) => ({ id: s.id, title: s.title, mtime: s.mtime })) });
});

app.delete("/api/sessions/:id", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  await AgentSession.delete(cwd, req.params.id);
  res.json({ ok: true });
});

// Same scope as the CLI's /config command: reads the merged (global +
// project) config, but only ever writes the global file — a web session has
// no separate notion of "project-local" beyond CWD itself. Secrets
// (apiKey/visionApiKey) are masked on the way out (never round-tripped in
// full to the browser) — a field is left untouched on save unless the
// request explicitly includes it.
app.get("/api/config", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const config = await loadConfig(cwd);
  const masked: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) {
    if (key === "apiKeys") continue; // array-valued — reported separately below
    const value = config[key];
    masked[key] = value && (SECRET_KEYS as readonly string[]).includes(key) ? maskSecret(value) : value;
  }
  res.json({ config: masked, apiKeys: (config.apiKeys ?? []).map(maskSecret), secretKeys: SECRET_KEYS });
});

app.post("/api/config", async (req, res) => {
  const body = req.body as Partial<FinanfaConfig>;
  const current = await loadConfig(DEFAULT_CWD);
  const next: FinanfaConfig = { ...current };
  for (const key of CONFIG_KEYS) {
    if (key === "apiKeys" || !(key in body)) continue;
    const value = body[key];
    // An empty string clears the field (matches /config's "unset by leaving
    // blank" convention); undefined/missing means "leave unchanged".
    if (value === "" || value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  // apiKeys arrives as a real array from the Settings textarea (one key per
  // line, already split client-side) — same "empty clears it" convention as
  // every other field, just array-shaped instead of a blank string.
  if ("apiKeys" in body) {
    const keys = Array.isArray(body.apiKeys) ? body.apiKeys.map((k) => k.trim()).filter(Boolean) : [];
    if (keys.length === 0) delete next.apiKeys;
    else next.apiKeys = keys;
  }
  await saveGlobalConfig(next);
  res.json({ ok: true, note: "Saved. Existing open chats keep their current provider/model — start a new chat to pick up the change." });
});

// Skills and memory already exist and do real work (loaded into every
// session's system prompt, memory writable by the agent itself via
// write_memory) — these just expose the same read the server already does
// at connect time, since there was previously no way to see them from the
// web UI at all.
app.get("/api/skills", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  res.json({ skills: await loadSkills(cwd) });
});

app.post("/api/skills", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const { name, description, content, scope } = req.body as { name?: string; description?: string; content?: string; scope?: "project" | "global" };
  if (!name || !content) {
    res.status(400).json({ error: "name and content are required" });
    return;
  }
  try {
    res.json(await writeSkill(cwd, { name, description: description ?? "", content, scope }));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/skills/:name", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const scope = req.query.scope === "global" ? "global" : "project";
  await deleteSkill(cwd, req.params.name, scope);
  res.json({ ok: true });
});

app.get("/api/memory", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  res.json({ memories: await loadMemories(cwd) });
});

app.post("/api/memory", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const { name, description, type, content, scope } = req.body as {
    name?: string;
    description?: string;
    type?: string;
    content?: string;
    scope?: "project" | "global";
  };
  if (!name || !content) {
    res.status(400).json({ error: "name and content are required" });
    return;
  }
  try {
    res.json(await writeMemory(cwd, { name, description: description ?? "", type: (type as MemoryType) ?? "user", content, scope }));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/memory/:name", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const scope = req.query.scope === "global" ? "global" : "project";
  await deleteMemory(cwd, req.params.name, scope);
  res.json({ ok: true });
});

app.get("/api/projects", async (_req, res) => {
  res.json({ projects: await listProjects(DEFAULT_CWD) });
});

app.post("/api/projects", async (req, res) => {
  const { name } = req.body as { name?: string };
  res.json({ project: await createProject(name ?? "") });
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    await deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// "Knowledge" files — reference material the user deliberately hands the
// agent for a project, distinct from a chat's ephemeral attach-button
// uploads (which land in .finanfa-code/uploads/ instead): these live in a
// plain, visible knowledge/ subfolder at the project root, so the agent
// finds them the normal way (glob/read_file/read_document), no special
// tooling needed.
app.get("/api/projects/:id/files", async (req, res) => {
  try {
    const dir = path.join(await resolveCwd(req.params.id), "knowledge");
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => {
          const st = await stat(path.join(dir, e.name));
          return { name: e.name, size: st.size };
        }),
    );
    res.json({ files });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/projects/:id/files", async (req, res) => {
  const { filename, dataBase64 } = req.body as { filename?: string; dataBase64?: string };
  if (!filename || !dataBase64) {
    res.status(400).json({ error: "filename and dataBase64 are required" });
    return;
  }
  try {
    const dir = path.join(await resolveCwd(req.params.id), "knowledge");
    await mkdir(dir, { recursive: true });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    await writeFile(path.join(dir, safeName), Buffer.from(dataBase64, "base64"));
    res.json({ ok: true, name: safeName });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/projects/:id/files/:name", async (req, res) => {
  try {
    const dir = path.join(await resolveCwd(req.params.id), "knowledge");
    const safeName = req.params.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    await rm(path.join(dir, safeName), { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Serves a raw file from a project's workspace (e.g. an MP3 text_to_speech
// just wrote) so the browser can play/view it inline — distinct from the
// knowledge-file routes above, which are scoped to the knowledge/
// subfolder specifically. resolveAllowedPath re-validates the path stays
// within that project's own cwd (or the server's home dir), same guard
// every tool's file access already goes through.
app.get("/api/workspace-file", async (req, res) => {
  const relPath = req.query.path;
  if (typeof relPath !== "string" || relPath.length === 0) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    const cwd = await resolveCwd(typeof req.query.project === "string" ? req.query.project : undefined);
    const fullPath = resolveAllowedPath(cwd, relPath);
    res.type(path.extname(fullPath) || "application/octet-stream");
    res.sendFile(fullPath);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/projects/:id/download", async (req, res) => {
  try {
    const dir = await resolveCwd(req.params.id);
    const zip = new JSZip();
    await addDirToZip(zip, dir, "");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.zip"`);
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// "Instructions" — a project-specific system prompt, shown to the user the
// way Claude/ChatGPT Projects show one. Not a new concept: this is exactly
// finanfa.md, already read by loadProjectInstructions and folded into the
// system prompt on every connection — these two routes just let the UI
// read/write that same real file directly instead of requiring a chat
// message ("edit finanfa.md to say...").
app.get("/api/projects/:id/instructions", async (req, res) => {
  try {
    const cwd = await resolveCwd(req.params.id);
    const content = await readFile(path.join(cwd, "finanfa.md"), "utf-8").catch(() => "");
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/projects/:id/instructions", async (req, res) => {
  const { content } = req.body as { content?: string };
  try {
    const cwd = await resolveCwd(req.params.id);
    await writeFile(path.join(cwd, "finanfa.md"), content ?? "", "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const clientDist = path.join(import.meta.dirname, "../../web-client/dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(404).send("finanfa-code-web: run `npm run build -w @finanfa/web-client` first, or use its dev server directly.");
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws: WebSocket, req) => {
  void handleConnection(ws, req.url ?? "");
});

async function handleConnection(ws: WebSocket, url: string): Promise<void> {
  const { adapter, resolvePending } = createWebUiAdapter(ws);
  const params = new URL(url, "http://localhost").searchParams;
  const requestedModel = params.get("model") ?? undefined;
  const requestedSessionId = params.get("session") ?? undefined;
  const requestedProjectId = params.get("project") ?? undefined;

  try {
    const CWD = await resolveCwd(requestedProjectId);
    const config = await loadConfig(CWD);
    const initial = selectProvider(config);
    const defaultModel = initial.defaultModel;
    // Mutable — switching to a model from a different provider family (see
    // "set_model" below) swaps both, not just the model string.
    let provider: LlmProvider = initial.provider;
    let providerKind: string = initial.kind;

    const tools = new ToolRegistry();
    registerBuiltins(tools, { sandbox: config.sandbox });

    const skills = await loadSkills(CWD);
    if (skills.length > 0) tools.register(createReadSkillTool(skills));
    tools.register(writeMemoryTool);
    const memories = await loadMemories(CWD);
    if (memories.length > 0) tools.register(createReadMemoryTool(CWD));

    const projectInstructions = await loadProjectInstructions(CWD);
    const designContract = await loadDesignContract(CWD);
    const systemPrompt =
      BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories) + formatProjectInstructions(projectInstructions);

    // The session's own (readonly) model wins on resume — a saved session
    // keeps whatever model it was created with, same as the CLI has no
    // /model command to change one mid-session either.
    let session: AgentSession;
    if (requestedSessionId) {
      try {
        session = await AgentSession.resume(CWD, requestedSessionId, systemPrompt);
      } catch (err) {
        adapter.writeError(
          `Could not resume session "${requestedSessionId}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
        );
        session = new AgentSession({ cwd: CWD, model: requestedModel ?? defaultModel, systemPrompt });
      }
    } else {
      session = new AgentSession({ cwd: CWD, model: requestedModel ?? defaultModel, systemPrompt });
    }
    const model = session.model;

    const permissionConfig = await loadPermissionConfig(CWD);
    const permissions = new PermissionManager({ config: permissionConfig, ui: adapter });

    const mcp = new McpClientManager();
    const browser = new BrowserManager();
    const { needsAuth } = await connectMcpServers(CWD, mcp, adapter);
    const needsAuthSet = new Set(needsAuth);
    for (const def of await mcp.listAllTools()) tools.register(def);

    registerStatefulBuiltins(tools, { provider, permissions, ui: adapter, model, cwd: CWD, browser, designContract: designContract.content, systemPrompt });

    function sendSessionInfo(): void {
      ws.send(
        JSON.stringify({
          type: "session_info",
          id: session.id,
          title: session.title,
          model: session.model,
          providerKind,
          toolCount: tools.list().length,
        }),
      );
    }

    async function sendMcpStatus(): Promise<void> {
      const configured = await loadMcpServers(CWD);
      const configuredNames = new Set(configured.map((s) => s.name));
      // The catalog fills in well-known connectors this project hasn't
      // added yet (a fresh project has no .finanfa-code/mcp.json at all) —
      // shown with a "+ Add" action same as Claude's own Connectors page,
      // rather than an empty panel until someone hand-writes the config.
      const all = [...configured, ...MCP_CATALOG.filter((c) => !configuredNames.has(c.name))];
      const connected = new Set(mcp.connectedServers());
      ws.send(
        JSON.stringify({
          type: "mcp_status",
          servers: all.map((s) => ({
            name: s.name,
            transport: s.transport,
            connected: connected.has(s.name),
            disabled: session.disabledMcpServers.has(s.name),
            needsAuth: needsAuthSet.has(s.name),
            inProject: configuredNames.has(s.name),
          })),
        }),
      );
    }

    async function reloadMcpTools(): Promise<void> {
      tools.unregisterByPrefix(MCP_TOOL_PREFIX);
      for (const def of await mcp.listAllTools()) tools.register(def);
    }

    // Sent as a structured event (not just parsed out of the text banner
    // below) so the client can sync its model selector / title state
    // exactly, including when a resumed session's model differs from
    // whatever was last selected in the UI.
    sendSessionInfo();
    void sendMcpStatus();
    // Replay past turns for a resumed session — tool activity itself isn't
    // replayed (it isn't stored as display-ready text), only the user/
    // assistant exchange, same as reopening a ChatGPT/Claude.ai thread.
    if (requestedSessionId && session.messages.length > 0) {
      ws.send(
        JSON.stringify({
          type: "history",
          messages: session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      );
      // Unlike the rest of tool activity, a generated audio/image file (see
      // ToolResult.media) IS meant to stay visible across a reload — it's
      // persisted on the tool-result message specifically for this. Sent
      // after the history event above so the client appends each player to
      // an already-populated timeline instead of racing it.
      for (const m of session.messages) {
        if (m.role !== "tool") continue;
        for (const r of m.results) {
          if (r.media) ws.send(JSON.stringify({ type: "media", ...r.media }));
        }
      }
    }

    let turnInFlight = false;

    ws.on("message", (raw: Buffer) => {
      void (async () => {
        let msg: { type: string; [key: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          adapter.writeError("Received a malformed message (not valid JSON).");
          return;
        }

        if (msg.type === "user_message" && typeof msg.text === "string") {
          if (turnInFlight) {
            adapter.writeError("A turn is already in progress — wait for it to finish (or interrupt) before sending another message.");
            return;
          }
          turnInFlight = true;
          try {
            const images = Array.isArray(msg.images) ? (msg.images as NeutralImage[]) : undefined;
            // Deep research: not a separate model/effort parameter (nothing
            // like that exists in the engine — see the "effort" discussion),
            // just a stronger per-turn instruction pushing the agent to
            // actually use its search/fetch tools thoroughly instead of
            // answering from memory. Real behavior change, honestly scoped.
            const text = msg.deepResearch
              ? "Do deep research for this: actively search the web and any other tools available (multiple queries/sources, " +
                "cross-check facts, fetch pages for real detail rather than trusting a snippet) before answering — don't answer " +
                `from memory alone if search tools can verify it. Take as many search/fetch steps as genuinely useful.\n\n${msg.text}`
              : msg.text;
            await runTurn(session, provider, adapter, tools, permissions, text, undefined, images);
            // Cleared here, not in the outer finally below — assistant_end
            // has already reached the client by this point (runTurn itself
            // sent it), so from the user's perspective the turn is over.
            // maybeGenerateTitle is a second, separate LLM call that doesn't
            // touch session.messages; gating /compact on it too just made
            // clicking Compact right after a response finishes fail with a
            // confusing "turn already in progress", for a call the client
            // has no visibility into at all.
            turnInFlight = false;
            const hadTitle = Boolean(session.title);
            await maybeGenerateTitle(session, provider);
            if (!hadTitle && session.title) sendSessionInfo();
          } catch (err) {
            adapter.writeError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            turnInFlight = false;
            await session.persist().catch((err) => adapter.writeError(`Failed to save session: ${err instanceof Error ? err.message : err}`));
          }
        } else if (msg.type === "permission_response" && typeof msg.requestId === "number" && typeof msg.answer === "string") {
          resolvePending(msg.requestId, msg.answer);
        } else if (msg.type === "interrupt") {
          for (const controller of session.activeAbortControllers) controller.abort();
        } else if (msg.type === "compact") {
          if (turnInFlight) {
            adapter.writeError("A turn is already in progress — wait for it to finish (or interrupt) before compacting.");
            return;
          }
          // Held for the duration of the compaction call itself (not just
          // checked at the start) — compactSession replaces session.messages
          // wholesale, so a user_message arriving mid-compaction and
          // appending to the same array while that replacement is in flight
          // would corrupt it. Same guard user_message itself uses.
          turnInFlight = true;
          try {
            adapter.setBusy(true, "compacting");
            const result = await compactSession(session, provider);
            adapter.setBusy(false);
            if (!result) {
              adapter.writeSystem("Nothing to compact, or the summarization call failed — conversation left unchanged.");
            } else {
              adapter.writeSystem(`Compacted ${result.messagesBefore} messages into a summary.`);
              // The client's timeline holds the old turns individually —
              // tell it to replace them with just the two-message summary
              // now actually in session.messages, same replay path a
              // resumed session's initial "history" event already uses.
              ws.send(
                JSON.stringify({
                  type: "history",
                  replace: true,
                  messages: session.messages
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .map((m) => ({ role: m.role, content: m.content })),
                }),
              );
            }
          } finally {
            turnInFlight = false;
          }
        } else if (msg.type === "set_model" && typeof msg.model === "string" && msg.model) {
          const family: ProviderFamily = msg.family === "openai-compatible" ? "openai-compatible" : "anthropic";
          if (typeof msg.baseUrl === "string" && msg.baseUrl) {
            // A detected local model (Ollama/LM Studio/...) — always rebuilt
            // directly against its own baseUrl, unconditionally, rather than
            // the family-change check below: two local models can both be
            // family "openai-compatible" but live at different baseUrls
            // (e.g. switching from Ollama to LM Studio), which that check
            // alone can't distinguish since it only fires on a family flip.
            // No API key — every local runtime here is unauthenticated.
            provider = new OpenAiCompatibleProvider({ baseUrl: msg.baseUrl, apiKey: undefined });
            providerKind = "openai-compatible";
          } else if (family !== providerKind) {
            const availability = await familyAvailability(config);
            if (!availability[family]) {
              ws.send(
                JSON.stringify({
                  type: "model_unavailable",
                  model: msg.model,
                  family,
                  message:
                    family === "anthropic"
                      ? "No Anthropic API key configured. Add one in Settings to use Claude models."
                      : "No base URL configured for an OpenAI-compatible provider. Add one in Settings to use this model.",
                }),
              );
              return;
            }
            provider = buildProvider(family, config);
            providerKind = family;
          }
          session.model = msg.model;
          sendSessionInfo();
        } else if (msg.type === "mcp_status") {
          await sendMcpStatus();
        } else if (msg.type === "mcp_connect" && typeof msg.name === "string") {
          const existing = await loadMcpServers(CWD);
          let config = existing.find((s) => s.name === msg.name);
          if (!config) {
            // Not yet in this project's mcp.json — if it's a known catalog
            // entry (see mcp-catalog.ts), add it there first, same file
            // write the CLI's own /mcp add does, then fall through to
            // connect it below.
            const fromCatalog = MCP_CATALOG.find((c) => c.name === msg.name);
            if (fromCatalog) {
              const file = path.join(CWD, ".finanfa-code", "mcp.json");
              await mkdir(path.dirname(file), { recursive: true });
              await writeFile(file, JSON.stringify({ servers: [...existing, fromCatalog] }, null, 2), "utf-8");
              config = fromCatalog;
            }
          }
          if (!config) {
            adapter.writeError(`No MCP server named "${msg.name}" in .finanfa-code/mcp.json.`);
          } else if (mcp.connectedServers().includes(msg.name)) {
            adapter.writeSystem(`"${msg.name}" is already connected.`);
          } else {
            if (config.transport !== "stdio") adapter.writeSystem(`Connecting to "${msg.name}" — if it requires authorization, a browser tab will open on the server...`);
            try {
              await mcp.connect(config);
              needsAuthSet.delete(msg.name);
              await reloadMcpTools();
              adapter.writeSystem(`Connected "${msg.name}".`);
            } catch (err) {
              adapter.writeError(`Failed to connect "${msg.name}": ${err instanceof Error ? err.message : err}`);
            }
          }
          await sendMcpStatus();
        } else if ((msg.type === "mcp_enable" || msg.type === "mcp_disable") && typeof msg.name === "string") {
          if (!mcp.connectedServers().includes(msg.name)) {
            adapter.writeError(`No connected MCP server named "${msg.name}".`);
          } else if (msg.type === "mcp_enable") {
            session.disabledMcpServers.delete(msg.name);
          } else {
            session.disabledMcpServers.add(msg.name);
          }
          await sendMcpStatus();
        } else if (msg.type === "mcp_reload") {
          await reloadMcpTools();
          adapter.writeSystem("MCP tools reloaded.");
          await sendMcpStatus();
        } else if (msg.type === "set_tool_enabled" && typeof msg.name === "string" && typeof msg.enabled === "boolean") {
          if (msg.enabled) session.disabledTools.delete(msg.name);
          else session.disabledTools.add(msg.name);
        }
      })();
    });

    ws.on("close", () => {
      void (async () => {
        for (const controller of session.activeAbortControllers) controller.abort();
        // A connection that never got a single message (page load followed
        // by navigating away, "New chat" clicked without typing, ...) used
        // to still persist an empty session file — every such no-op visit
        // left a permanent blank "New chat" entry in the sidebar, which is
        // what made deleting one look like it silently spawned another: the
        // *next* empty connection's close was writing a fresh ghost entry
        // around the same time. Real bug, not a UI issue.
        if (session.messages.length > 0) await session.persist().catch(() => {});
        await mcp.disconnectAll().catch(() => {});
        await browser.close().catch(() => {});
      })();
    });
  } catch (err) {
    adapter.writeError(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
    ws.close();
  }
}

httpServer.listen(PORT, () => {
  console.log(`finanfa-code-web server listening on http://localhost:${PORT} (default workspace: ${DEFAULT_CWD})`);
});
