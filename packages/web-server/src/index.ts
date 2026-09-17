import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle, compactSession, isLoopGuardStopMessage } from "@finanfa/core/src/core/loop.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { loadHooksConfig } from "@finanfa/core/src/hooks/config.js";
import { resolveTrust } from "@finanfa/core/src/core/trust-gate.js";
import { loadSubagentTypes } from "@finanfa/core/src/agents/loader.js";
import { McpClientManager, MCP_TOOL_PREFIX } from "@finanfa/core/src/mcp/client-manager.js";
import { loadMcpServers } from "@finanfa/core/src/mcp/config.js";
import { MCP_CATALOG } from "./mcp-catalog.js";
import { loadSkills, formatSkillIndex, createReadSkillTool, writeSkill, deleteSkill } from "@finanfa/core/src/skills/loader.js";
import {
  loadMemories,
  formatMemoryIndex,
  createReadMemoryTool,
  writeMemoryTool,
  deleteMemoryTool,
  findDuplicateMemoriesTool,
  writeMemory,
  deleteMemory,
  type MemoryType,
} from "@finanfa/core/src/memory/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadScopedInstructions, formatScopedInstructions } from "@finanfa/core/src/core/scoped-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig, saveGlobalConfig, thinkingBudgetTokensFromConfig, type FinanfaConfig } from "@finanfa/core/src/core/config.js";
import { CONFIG_KEYS, SECRET_KEYS, maskSecret } from "@finanfa/core/src/commands/builtin.js";
import { BASE_SYSTEM_PROMPT, selectProvider, connectMcpServers, parseApiKeys } from "@finanfa/core/src/app.js";
import { detectLocalProviders } from "@finanfa/core/src/core/local-providers.js";
import {
  isDockerModelRunnerAvailable,
  listDockerModels,
  searchDockerModels,
  pullDockerModel,
  deleteDockerModel,
  purgeDockerModels,
} from "@finanfa/core/src/core/docker-models.js";
import { isOllamaAvailable, listOllamaModels, pullOllamaModel, deleteOllamaModel } from "@finanfa/core/src/core/ollama-models.js";
import { EFFORT_TIERS, getEffortTier, isDefaultProviderTier, MINIMAL_TOOL_SET } from "@finanfa/core/src/core/effort-tiers.js";
import { AnthropicProvider } from "@finanfa/core/src/providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "@finanfa/core/src/providers/openai-compatible-provider.js";
import type { LlmProvider, NeutralImage } from "@finanfa/core/src/core/types.js";
import { PRICING } from "@finanfa/core/src/core/pricing.js";
import { createWebUiAdapter } from "./web-ui-adapter.js";
import { resolveAllowedPath } from "@finanfa/core/src/tools/builtin/path-guard.js";
import { initTracing } from "@finanfa/core/src/observability/tracing.js";
import { loadPlugins } from "@finanfa/core/src/plugins/loader.js";
import { CommandRegistry } from "@finanfa/core/src/commands/registry.js";
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
import { registerSlackChannelRoutes } from "./channels-slack.js";
import { registerTelegramChannelRoutes } from "./channels-telegram.js";
import { registerDiscordChannelRoutes } from "./channels-discord.js";
import { registerWhatsappChannelRoutes } from "./channels-whatsapp.js";
import { registerSmsChannelRoutes } from "./channels-sms.js";
import { registerVoiceChannelRoutes } from "./channels-voice.js";
import { parseWebUsers, authenticateBearerToken, authenticateQueryToken } from "./auth.js";
import { SessionTokenStore } from "./session-token-store.js";
import { loadUserStore, createUser, verifyUserPassword } from "./user-store.js";
import { oidcConfigFromEnv, discoverOidcEndpoints, buildAuthorizationUrl, exchangeCodeForToken, fetchOidcUserInfo, OidcStateStore } from "./oidc.js";

// The workspace the "default" project points at — the same "cwd" concept as
// running the CLI from that directory, and the only workspace that existed
// before Projects did (kept working unchanged for anyone not using Projects
// at all). Every other project is a real directory under
// projects.ts's PROJECTS_ROOT, picked per-connection/per-request below.
// Same behavior as the CLI's --prompt mode (cli.ts): a genuinely large task
// can legitimately hit runTurn's own step-limit guard well before finishing.
// Interactively there's a human who could just type "continue" themselves,
// but making them notice the cutoff and do that by hand for a task like
// "build me a complete app" is exactly the friction --max-turns removed on
// the CLI side — this gives the web UI the same automatic recovery, each
// auto-continue still announced via writeSystem so it's never silent.
const WEB_MAX_AUTO_CONTINUE_TURNS = 5;

const DEFAULT_CWD = process.env.FINANFA_WEB_CWD ?? process.cwd();
const PORT = Number(process.env.PORT ?? 4600);
/** Undefined means no static shared-secret tokens are configured — see auth.ts. Real per-login accounts (GATEWAY_ENABLED, below) work independently of this. */
const WEB_USERS = parseWebUsers();
/** In-memory session tokens issued by POST /api/auth/login or a completed OIDC login — see session-token-store.ts. Always constructed (cheap, no I/O); only ever consulted when GATEWAY_ENABLED. */
const AUTH_SESSIONS = new SessionTokenStore();
/** Undefined means SSO login isn't configured — see oidc.ts. */
const OIDC_CONFIG = oidcConfigFromEnv();
/** Pending (state -> PKCE verifier) OIDC login attempts — see oidc.ts. */
const OIDC_STATES = new OidcStateStore();
/**
 * Gateway auth is on when ANY of a static FINANFA_WEB_USERS token map,
 * FINANFA_WEB_ACCOUNTS=1 (real per-login password accounts — see
 * user-store.ts), or OIDC SSO (above) is configured — all three are
 * independent and can be combined. Off (none set) means every request/
 * connection is treated as an unauthenticated single shared user, exactly
 * as before this feature existed.
 */
const GATEWAY_ENABLED = Boolean(WEB_USERS) || process.env.FINANFA_WEB_ACCOUNTS === "1" || Boolean(OIDC_CONFIG);

const app = express();
app.use(
  express.json({
    limit: "25mb", // images arrive as base64 JSON — comfortably over a typical photo's encoded size
    // Stashes the exact raw bytes alongside the parsed body — channels-slack.ts's
    // signature verification covers these exact bytes, not a re-serialized
    // JSON.parse/stringify round trip (which can reorder keys/whitespace and
    // invalidate an otherwise-genuine signature).
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

registerSlackChannelRoutes(app, DEFAULT_CWD);
registerTelegramChannelRoutes(app, DEFAULT_CWD);
registerDiscordChannelRoutes(app, DEFAULT_CWD);
registerWhatsappChannelRoutes(app, DEFAULT_CWD);
registerSmsChannelRoutes(app, DEFAULT_CWD);
registerVoiceChannelRoutes(app, DEFAULT_CWD);

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
/** True for a baseUrl pointed at this machine itself (localhost/127.0.0.1/::1) — a locally-run model, as opposed to a remote hosted API. */
function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Real capability lookup against Ollama's own /api/tags, not a guess by name/size — returns undefined for a local runtime that isn't Ollama (LM Studio/llama.cpp/vLLM) or that this model name isn't in, since there's no signal to act on either way. */
async function lookupOllamaToolSupport(modelName: string): Promise<boolean | undefined> {
  try {
    const models = await listOllamaModels();
    return models.find((m) => m.name === modelName)?.supportsTools;
  } catch {
    return undefined;
  }
}

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
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID ?? config.anthropicWorkspaceId;
    return new AnthropicProvider(apiKey, workspaceId);
  }
  const baseUrl = process.env.FINANFA_BASE_URL ?? (savedFamily === "openai-compatible" ? config.baseUrl : undefined);
  if (!baseUrl) throw new Error("openai-compatible requires a base URL — checked by the caller via familyAvailability first.");
  const apiKey = process.env.FINANFA_API_KEY ?? (savedFamily === "openai-compatible" ? config.apiKey : undefined);
  const apiKeys = parseApiKeys(process.env.FINANFA_API_KEYS) ?? (savedFamily === "openai-compatible" ? config.apiKeys : undefined);
  return new OpenAiCompatibleProvider({ baseUrl, apiKey, apiKeys });
}

// Real per-login accounts (hashed passwords, see user-store.ts) — routes
// registered BEFORE the blanket auth gate below so logging in doesn't
// itself require a token, same reasoning as the channel webhooks above.
// Both routes work whether GATEWAY_ENABLED is on or off (creating/
// logging into an account is harmless either way), but only matter once
// it's on — a login's session token is otherwise never checked by
// anything.
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "username and password are both required." });
    return;
  }
  if (!(await verifyUserPassword(username, password))) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  res.json({ token: AUTH_SESSIONS.issue(username), user: username });
});

app.post("/api/auth/users", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "username and password are both required." });
    return;
  }
  // Bootstrap: creating the very first account ever needs no auth (there's
  // no way to have a valid token yet) — every account after that requires
  // one, so a stranger who finds this server can't just add themselves.
  const existingUsers = await loadUserStore();
  if (Object.keys(existingUsers).length > 0) {
    const user = authenticateBearerToken(WEB_USERS ?? new Map(), AUTH_SESSIONS, req.header("authorization"));
    if (!user) {
      res.status(401).json({ error: "Creating an account requires being logged in as an existing one, once at least one exists." });
      return;
    }
  }
  const result = await createUser(username, password);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

// Real OIDC-based SSO ("log in with Google/Okta/any OIDC provider")
// alongside password accounts and static tokens — see oidc.ts for the
// actual protocol. Both routes are deliberately before the auth gate
// below: /login redirects an unauthenticated browser to the provider,
// and /callback is where that provider redirects back to, neither of
// which can carry a finanfa-code token yet.
if (OIDC_CONFIG) {
  const oidcConfig = OIDC_CONFIG;
  app.get("/api/auth/oidc/login", async (_req, res) => {
    try {
      const endpoints = await discoverOidcEndpoints(oidcConfig.issuer);
      const { state, challenge } = OIDC_STATES.create();
      res.redirect(buildAuthorizationUrl(endpoints, oidcConfig, state, challenge));
    } catch (err) {
      res.status(502).json({ error: `OIDC discovery failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get("/api/auth/oidc/callback", async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state." });
      return;
    }
    const verifier = OIDC_STATES.consume(state);
    if (!verifier) {
      res.status(400).json({ error: "Unknown, expired, or already-used state — start the login again." });
      return;
    }
    try {
      const endpoints = await discoverOidcEndpoints(oidcConfig.issuer);
      const tokenResult = await exchangeCodeForToken(endpoints, oidcConfig, code, verifier);
      if (!tokenResult.ok) {
        res.status(401).json({ error: tokenResult.error });
        return;
      }
      const userInfoResult = await fetchOidcUserInfo(endpoints, tokenResult.accessToken);
      if (!userInfoResult.ok) {
        res.status(401).json({ error: userInfoResult.error });
        return;
      }
      const sessionToken = AUTH_SESSIONS.issue(userInfoResult.username);
      // A URL fragment (#...), not a query param — never sent to the
      // server on a later request, so it doesn't end up in access logs or
      // get forwarded via a Referer header the way a query param could.
      res.redirect(`/#token=${encodeURIComponent(sessionToken)}&user=${encodeURIComponent(userInfoResult.username)}`);
    } catch (err) {
      res.status(502).json({ error: `OIDC login failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

// Gateway auth gate — every /api/* route registered from here on requires
// a valid token when GATEWAY_ENABLED (channel webhooks above have their
// own signature verification instead, and are never meant to carry one of
// these tokens, so they're registered before this middleware and never
// reach it; /api/auth/* above is also deliberately before this gate). A
// no-op when GATEWAY_ENABLED is false.
if (GATEWAY_ENABLED) {
  const users = WEB_USERS ?? new Map<string, string>();
  app.use("/api", (req, res, next) => {
    const user = authenticateBearerToken(users, AUTH_SESSIONS, req.header("authorization"));
    if (!user) {
      res.status(401).json({ error: "Missing or invalid Authorization: Bearer <token>." });
      return;
    }
    req.user = user;
    next();
  });
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

app.get("/api/docker-models/status", async (_req, res) => {
  res.json({ available: await isDockerModelRunnerAvailable() });
});

app.get("/api/docker-models/installed", async (_req, res) => {
  try {
    res.json({ models: await listDockerModels() });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/docker-models/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  try {
    res.json({ results: await searchDockerModels(query, 30) });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// A pull can take anywhere from seconds (small model) to minutes (a large
// one over a slow connection) — Server-Sent Events so the client can show
// real progress instead of a spinner with no feedback for however long
// that takes. One "line" event per real stdout/stderr line from the CLI,
// then one "done"/"error" event; the connection closes either way.
app.get("/api/docker-models/pull", (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  pullDockerModel(
    name,
    (line) => res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`),
    controller.signal,
  )
    .then(() => res.write("event: done\ndata: {}\n\n"))
    .catch((err) => res.write(`event: error\ndata: ${JSON.stringify(err instanceof Error ? err.message : String(err))}\n\n`))
    .finally(() => res.end());
});

// A model name can itself contain "/" (e.g. "ai/qwen3",
// "huggingface.co/qwen/qwen2.5-coder-3b-instruct-gguf:Q4_K_M") — a query
// param, same as the pull endpoint above, avoids URL-encoding it into a
// path segment.
app.delete("/api/docker-models", async (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    await deleteDockerModel(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Removes every pulled model in one call, for "clear all of them" rather
// than one at a time. A distinct path from the single-model delete above
// (which takes ?name=) rather than overloading the same route on presence/
// absence of a query param.
app.delete("/api/docker-models/purge", async (_req, res) => {
  try {
    await purgeDockerModels();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Static catalog — no per-request work — plus each local tier's real
// installed/missing state, so the UI can show "download needed" without a
// separate round trip.
app.get("/api/effort-tiers", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const config = await loadConfig(cwd);
  const { defaultModel } = selectProvider(config);
  const ollamaModels = (await isOllamaAvailable().catch(() => false)) ? await listOllamaModels().catch(() => []) : [];
  const installedNames = new Set(ollamaModels.map((m) => m.name));
  res.json({
    tiers: EFFORT_TIERS.map((t) => ({
      ...t,
      model: isDefaultProviderTier(t) ? (defaultModel ?? t.model) : t.model,
      installed: t.ollamaModel ? installedNames.has(t.ollamaModel) : true,
    })),
  });
});

app.get("/api/ollama-models/status", async (_req, res) => {
  res.json({ available: await isOllamaAvailable() });
});

app.get("/api/ollama-models/installed", async (_req, res) => {
  try {
    res.json({ models: await listOllamaModels() });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Same SSE-streamed-progress shape as /api/docker-models/pull above, but
// forwarding Ollama's own structured {status, completed, total} progress
// objects (one "progress" event per NDJSON line from /api/pull) instead of
// opaque CLI text lines.
app.get("/api/ollama-models/pull", (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  pullOllamaModel(
    name,
    (p) => res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`),
    controller.signal,
  )
    .then(() => res.write("event: done\ndata: {}\n\n"))
    .catch((err) => res.write(`event: error\ndata: ${JSON.stringify(err instanceof Error ? err.message : String(err))}\n\n`))
    .finally(() => res.end());
});

app.delete("/api/ollama-models", async (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    await deleteOllamaModel(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
  // Auth off (req.user undefined): every session is listed, same as before
  // this feature existed. Auth on: only this user's own sessions, plus any
  // legacy/ownerless one (predates this field, or was created by a CLI/VS
  // Code/ACP session sharing the same project) — never another user's.
  const visible = GATEWAY_ENABLED ? sessions.filter((s) => !s.ownerUser || s.ownerUser === req.user) : sessions;
  res.json({ sessions: visible.map((s) => ({ id: s.id, title: s.title, mtime: s.mtime })) });
});

app.delete("/api/sessions/:id", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  if (GATEWAY_ENABLED) {
    const owner = await AgentSession.ownerOf(cwd, req.params.id);
    if (owner && owner !== req.user) {
      res.status(403).json({ error: "This session belongs to a different user." });
      return;
    }
  }
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
  const url = req.url ?? "";
  if (GATEWAY_ENABLED) {
    const token = new URL(url, "http://localhost").searchParams.get("token");
    const user = authenticateQueryToken(WEB_USERS ?? new Map(), AUTH_SESSIONS, token);
    if (!user) {
      ws.close(4001, "Missing or invalid ?token=");
      return;
    }
    void handleConnection(ws, url, user);
    return;
  }
  void handleConnection(ws, url, undefined);
});

async function handleConnection(ws: WebSocket, url: string, user: string | undefined): Promise<void> {
  const { adapter, resolvePending } = createWebUiAdapter(ws);

  // Registered immediately — not just as part of the big ws.on("message")
  // handler further down, which isn't attached until session/tools/
  // permissions setup finishes. resolveTrust (called during that setup,
  // below) can itself send an "ask" prompt and await its answer; without
  // this early listener, a permission_response answering it arrives with
  // nothing yet listening to relay it to resolvePending(), and
  // handleConnection hangs forever awaiting a reply that already arrived.
  // Real bug, caught by an actual WebSocket round-trip test, not a guess —
  // multiple "message" listeners on the same ws are fine in Node; this one
  // only ever touches permission_response, the later handler's own
  // (redundant but harmless) resolvePending call just finds nothing left.
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; requestId?: unknown; answer?: unknown };
      if (msg.type === "permission_response" && typeof msg.requestId === "number" && typeof msg.answer === "string") {
        resolvePending(msg.requestId, msg.answer);
      }
    } catch {
      // Malformed JSON is handled (with a user-visible error) by the main
      // message handler below once it's attached — nothing to do here.
    }
  });

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
    tools.register(deleteMemoryTool);
    const memories = await loadMemories(CWD);
    if (memories.length > 0) {
      tools.register(createReadMemoryTool(CWD));
      tools.register(findDuplicateMemoriesTool);
    }

    const projectInstructions = await loadProjectInstructions(CWD);
    const scopedInstructions = await loadScopedInstructions(CWD);
    const designContract = await loadDesignContract(CWD);
    const systemPrompt =
      BASE_SYSTEM_PROMPT +
      formatSkillIndex(skills) +
      formatMemoryIndex(memories) +
      formatProjectInstructions(projectInstructions) +
      formatScopedInstructions(scopedInstructions);

    // The session's own (readonly) model wins on resume — a saved session
    // keeps whatever model it was created with, same as the CLI has no
    // /model command to change one mid-session either.
    let session: AgentSession;
    if (requestedSessionId) {
      try {
        session = await AgentSession.resume(CWD, requestedSessionId, systemPrompt);
        // Auth on, session already has a different owner: refuse the resume
        // outright rather than silently handing one user's conversation
        // history to another. A session with no owner recorded yet (predates
        // this field, or was created by a non-web entry point sharing this
        // project) is treated as unclaimed — resuming it adopts it below.
        if (GATEWAY_ENABLED && session.ownerUser && session.ownerUser !== user) {
          adapter.writeError(`Session "${requestedSessionId}" belongs to a different user.`);
          ws.close(4003, "Session belongs to a different user");
          return;
        }
      } catch (err) {
        adapter.writeError(
          `Could not resume session "${requestedSessionId}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
        );
        session = new AgentSession({ cwd: CWD, model: requestedModel ?? defaultModel, systemPrompt });
      }
    } else {
      session = new AgentSession({ cwd: CWD, model: requestedModel ?? defaultModel, systemPrompt });
    }
    if (GATEWAY_ENABLED) session.ownerUser = user;
    if (session.thinkingBudgetTokens === undefined) session.thinkingBudgetTokens = thinkingBudgetTokensFromConfig(config);
    const model = session.model;

    // Reconstructs the provider/endpoint this session actually last talked
    // to, if it ever switched away from the global/project default (see
    // the "set_model" handler below, which is the only thing that ever
    // sets these two fields) — otherwise `initial` above (the ordinary
    // config-derived default) is exactly right and this is a no-op. Without
    // this, a resumed session whose last-used model belonged to a local
    // runtime kept that model's name but silently reverted to whatever
    // provider is configured as the default, sending a model name that
    // provider had never heard of.
    if (session.providerBaseUrl) {
      provider = new OpenAiCompatibleProvider({ baseUrl: session.providerBaseUrl, apiKey: undefined });
      providerKind = "openai-compatible";
    } else if (session.providerKind && session.providerKind !== providerKind) {
      const family: ProviderFamily = session.providerKind === "openai-compatible" ? "openai-compatible" : "anthropic";
      const availability = await familyAvailability(config);
      if (availability[family]) {
        provider = buildProvider(family, config);
        providerKind = family;
      } else {
        adapter.writeError(
          `This session was last using a ${family} model, but ${family} isn't configured — falling back to the default (${providerKind}). Switch models or update Settings to restore it.`,
        );
      }
    }

    // Same folder-trust gate the CLI applies (see core/trust-gate.ts): a
    // project's own .finanfa-code/settings.json can define permission
    // rules and hooks that run automatically — including a PreToolUse hook
    // that auto-approves every tool call — so it must never take effect
    // just because the web server happened to be pointed at that
    // directory. resolveTrust prompts over the same askUser round-trip
    // permission prompts already use; nonInteractive is never set here
    // (the web UI always has a live client to answer it).
    const trusted = await resolveTrust(CWD, adapter);
    const permissionConfig = await loadPermissionConfig(CWD, trusted);
    const hooksConfig = await loadHooksConfig(CWD, trusted);
    const permissions = new PermissionManager({ config: permissionConfig, ui: adapter, hooksConfig });

    // Plugins are arbitrary imported JS, not inert config like hooks —
    // gated on the same folder-trust decision above, not loaded before it.
    // The web UI has no slash-command surface yet, so a plugin's
    // registerCommands (if any) is a no-op here — only registerTools takes
    // effect, same as it would with any other tool-provider.
    const plugins = trusted ? await loadPlugins(CWD, tools, new CommandRegistry()) : [];
    if (plugins.length > 0) console.log(`[${CWD}] Plugins: ${plugins.join(", ")}`);

    const mcp = new McpClientManager();
    const browser = new BrowserManager();
    const { needsAuth } = await connectMcpServers(CWD, mcp, adapter);
    const needsAuthSet = new Set(needsAuth);
    for (const def of await mcp.listAllTools()) tools.register(def);

    const agentTypes = await loadSubagentTypes(CWD);
    registerStatefulBuiltins(tools, { provider, permissions, ui: adapter, model, cwd: CWD, browser, designContract: designContract.content, systemPrompt, agentTypes });

    function sendSessionInfo(): void {
      ws.send(
        JSON.stringify({
          type: "session_info",
          id: session.id,
          title: session.title,
          model: session.model,
          providerKind,
          toolCount: tools.list().length,
          effort: session.effort,
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

    // Lets the client manage the full tool list (see the "Tools" panel) —
    // the web UI previously had no equivalent of the CLI's /tools command
    // at all, a real problem for a small-context local model: this
    // project's system prompt + full tool list alone can run to tens of
    // thousands of tokens, easily overflowing a 4k/8k-context local model
    // before a single user message is even added. Disabling most tools
    // here is the direct, immediate fix for that — this is what makes it
    // reachable from the browser.
    function sendToolsStatus(): void {
      ws.send(
        JSON.stringify({
          type: "tools_status",
          tools: tools.list().map((t) => ({ name: t.name, riskLevel: t.riskLevel, enabled: !session.disabledTools.has(t.name) })),
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
    // Real, reported gap: a failed turn's error message only ever reached
    // the client as a one-off "error" WS event, never part of `messages`
    // (appending it there would resend it to the model on every later
    // call) — so it was silently gone the moment the connection closed,
    // not just the ordinary chat text. session.errorLog (see
    // AgentSession's own doc comment) records each one against the
    // message-array position it happened at, so it can be spliced back
    // into the replay at the right spot instead of all bunched together.
    if (requestedSessionId && (session.messages.length > 0 || session.errorLog.length > 0)) {
      const replay: { role: "user" | "assistant" | "error"; content: string }[] = [];
      let errorIdx = 0;
      for (let i = 0; i <= session.messages.length; i++) {
        while (errorIdx < session.errorLog.length && session.errorLog[errorIdx]!.afterMessageIndex === i) {
          replay.push({ role: "error", content: session.errorLog[errorIdx]!.text });
          errorIdx++;
        }
        const m = session.messages[i];
        if (m && (m.role === "user" || m.role === "assistant")) replay.push({ role: m.role, content: m.content });
      }
      ws.send(JSON.stringify({ type: "history", messages: replay }));
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

    // The current todo_write checklist likewise isn't part of `messages`
    // (it lives on session.todos, see AgentSession) — replayed here so a
    // reconnect to a still-running session (a browser reload, a second
    // tab) sees the board as it currently stands, not empty until the
    // next todo_write call.
    if (session.todos.list().length > 0) ws.send(JSON.stringify({ type: "todos", todos: session.todos.list() }));

    let turnInFlight = false;
    // Per-connection, not persisted on the session — reopening a session
    // later should warn again (a fresh reminder is fine there), this is
    // only about not repeating the same warning for every single model
    // switch within one already-informed browser tab.
    let warnedAboutLocalModelThisConnection = false;

    // Real, reproduced race: this handler used to spawn an independent,
    // unserialized async IIFE per incoming message — two messages sent
    // back-to-back (e.g. the web client's own "switch effort tier, then
    // immediately send the first message" flow) could have their async
    // work interleave. set_effort/set_model do real awaited work (probing
    // Ollama) before reassigning `provider`/session.model; a user_message
    // arriving during that window used to start runTurn immediately,
    // capturing the STALE provider/model for that one turn instead of
    // waiting for the switch already in flight to land — reproduced
    // directly against a real fake-provider HTTP server logging which
    // model name it actually received. Chaining every message onto one
    // per-connection queue makes them process strictly in arrival order,
    // each fully finishing (including its own awaits) before the next
    // starts — no message can ever observe another's half-applied state.
    let messageQueue: Promise<void> = Promise.resolve();
    ws.on("message", (raw: Buffer) => {
      // Real reported bug: interrupt must preempt an in-flight turn, not
      // wait behind it in the queue below — queuing every message (added
      // just above to fix a real race between set_effort/set_model and a
      // user_message landing mid-switch) accidentally broke Stop entirely.
      // An interrupt sent while a turn was running only ever ran once that
      // turn had already finished on its own (queued behind its
      // still-awaiting handleMessage), by which point activeAbortControllers
      // was already empty — a complete no-op, indistinguishable from Stop
      // doing nothing at all. interrupt is the one message safe to run
      // immediately, out of order: it only ever aborts whatever's currently
      // active and never touches state a later queued message could
      // observe half-applied.
      try {
        const peek = JSON.parse(raw.toString()) as { type?: string };
        if (peek.type === "interrupt") {
          for (const controller of session.activeAbortControllers) controller.abort();
          return;
        }
      } catch {
        // Malformed JSON — falls through to the queue below, which already
        // reports this the same way it always has.
      }
      messageQueue = messageQueue.then(handleMessage).catch((err) => {
        console.error(`Unhandled error handling a WS message for session ${session.id}:`, err);
      });
      async function handleMessage(): Promise<void> {
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
            let nextText: string = text;
            let nextImages = images;
            for (let turn = 1; turn <= WEB_MAX_AUTO_CONTINUE_TURNS; turn++) {
              await runTurn(session, provider, adapter, tools, permissions, nextText, undefined, nextImages);
              const last = session.messages.at(-1);
              const stoppedByGuard = last?.role === "assistant" && typeof last.content === "string" && isLoopGuardStopMessage(last.content);
              if (!stoppedByGuard || turn === WEB_MAX_AUTO_CONTINUE_TURNS) break;
              adapter.writeSystem(`(auto-continuing: cut off by the step-limit guard — turn ${turn + 1}/${WEB_MAX_AUTO_CONTINUE_TURNS})`);
              nextText = "continue";
              nextImages = undefined;
            }
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
          // Real, reported bug: switching FROM a local model (a specific
          // baseUrl override, e.g. Ollama) back TO a normal same-family
          // model (e.g. the configured default openai-compatible provider)
          // left `provider` pointed at the OLD local baseUrl — the family
          // hadn't changed ("openai-compatible" both times), so the
          // family-mismatch rebuild below never fired, and only
          // session.model was updated. The next call then sent the new
          // model's name to the old local server, which had never heard of
          // it (404). Tracked here so switching away from a baseUrl
          // override always forces a rebuild, even within the same family.
          const hadBaseUrlOverride = Boolean(session.providerBaseUrl);
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
          } else if (family !== providerKind || hadBaseUrlOverride) {
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
          // Persisted alongside model so a resume (crash, restart, page
          // reload) reconstructs the SAME provider/endpoint this session
          // actually last talked to, instead of always defaulting back to
          // the global/project config's provider — a real, reproduced bug:
          // a session last using a local model kept that model's name on
          // resume, but session.persist() had nowhere to remember it was
          // local at all, so the freshly reconnected session silently sent
          // that (to it, meaningless) local model name to the default
          // remote provider instead, which naturally rejected it. Cleared
          // (not left stale) when this switch has no baseUrl of its own —
          // e.g. switching back to a normal remote model after a local one.
          session.providerKind = providerKind;
          session.providerBaseUrl = typeof msg.baseUrl === "string" && msg.baseUrl ? msg.baseUrl : undefined;
          session.model = msg.model;
          // A manual pick through this plain picker is a distinct action
          // from an effort tier (see set_effort below) — the "effort" badge
          // shouldn't keep claiming Faible/Moyen/Fort once the user has
          // overridden it by hand.
          const hadEffort = Boolean(session.effort);
          session.effort = undefined;
          if (typeof msg.baseUrl === "string" && msg.baseUrl && isLocalBaseUrl(msg.baseUrl)) {
            // Real, reported crashes from picking a local model directly
            // through this plain picker (bypassing the Effort tiers, whose
            // whole job is protecting against exactly this): qwen3:4b's
            // default 4096-token context can't hold this project's own
            // ~40k-token system-prompt-plus-full-tool-list, and some models
            // (gemma2, yi-coder) don't support tool calling at all — both
            // failed outright. Applying the same protective tool budget the
            // Effort tiers use — derived from the model's real, reported
            // capabilities, not a guess — closes that gap here too, instead
            // of only warning about it after the user already hit the wall.
            const supportsTools = await lookupOllamaToolSupport(msg.model);
            session.disabledTools.clear();
            if (supportsTools === false) {
              for (const t of tools.list()) session.disabledTools.add(t.name);
            } else if (supportsTools === true) {
              for (const t of tools.list()) if (!MINIMAL_TOOL_SET.includes(t.name)) session.disabledTools.add(t.name);
            }
            // undefined (unknown runtime, e.g. LM Studio/llama.cpp/vLLM
            // that doesn't expose Ollama's capabilities field, or the
            // lookup itself failed) — no signal to act on, leave as-is.
            sendToolsStatus();
          } else if (hadEffort) {
            session.disabledTools.clear();
            sendToolsStatus();
          }
          sendSessionInfo();
          // Real, reported case: switching to a local model and sending one
          // message crashed the whole machine — not this project's bug in
          // the usual sense, but a real consequence of this project's own
          // behavior: every call includes the full tool list (100+ tools,
          // several tens of thousands of tokens on its own, before any
          // conversation). A local runtime (Ollama, Docker Model Runner,
          // llama.cpp, ...) has to allocate KV-cache proportional to
          // whatever context that prompt needs — on constrained hardware
          // (no/limited GPU, modest RAM) that allocation can exhaust memory
          // badly enough to take the whole system down, not just fail
          // cleanly the way a remote API would. Warned here, proactively,
          // the moment a local model is selected — before the crash, not
          // only after it via the "context size exceeded" error message.
          // Once per connection, not once per switch — the risk is exactly
          // the same for every local model (it's about the tool list this
          // agent always sends, not about which specific model you picked),
          // so repeating it on every single switch just becomes noise
          // someone trying several local models in a row has to scroll
          // past — a real, reported annoyance.
          if (!warnedAboutLocalModelThisConnection && session.providerBaseUrl && isLocalBaseUrl(session.providerBaseUrl)) {
            warnedAboutLocalModelThisConnection = true;
            const enabledToolCount = tools.list().filter((t) => !session.disabledTools.has(t.name)).length;
            adapter.writeSystem(
              `⚠ ${msg.model} is a local model — every message sent here includes this agent's full system prompt ` +
                `and tool list (currently ${enabledToolCount} tools, tens of thousands of tokens on its own, before ` +
                "any conversation). On a machine with limited RAM/no GPU, a local runtime trying to allocate enough " +
                "context for that can exhaust memory badly enough to freeze or crash the whole system, not just fail " +
                "cleanly. If that happens, use /tools (or the Tools panel here) to disable most tools before trying " +
                "a local model again — a handful of tools is a much smaller, safer prompt than the full set.",
            );
          }
        } else if (msg.type === "set_effort" && typeof msg.level === "string") {
          // Shortcut past manually picking a model + remembering to strip
          // tools every time: one message picks a model, a max_tokens cap,
          // and a curated tool budget together (see effort-tiers.ts for why
          // each tier's exact settings are what they are).
          const tier = getEffortTier(msg.level);
          if (!tier) {
            ws.send(JSON.stringify({ type: "error", message: `Unknown effort level: ${msg.level}` }));
            return;
          }
          if (tier.ollamaModel) {
            const available = await isOllamaAvailable().catch(() => false);
            const installed = available && (await listOllamaModels().catch(() => [])).some((m) => m.name === tier.ollamaModel);
            if (!installed) {
              ws.send(JSON.stringify({ type: "effort_needs_download", level: tier.id, ollamaModel: tier.ollamaModel }));
              return;
            }
          }
          // "high" has no fixed model/family of its own — it means "this
          // project's already-configured default provider", whatever that
          // is (Poolside via openai-compatible, Anthropic, ...), not a
          // hardcoded family. Resolving it wrong here would mean "high"
          // silently requiring an Anthropic key even for a project whose
          // actual default is an openai-compatible endpoint like Poolside.
          let resolvedModel = tier.model;
          let resolvedFamily = tier.family;
          if (isDefaultProviderTier(tier)) {
            try {
              const selected = selectProvider(config);
              resolvedModel = selected.defaultModel;
              resolvedFamily = selected.kind === "openai-compatible" ? "openai-compatible" : "anthropic";
            } catch {
              ws.send(
                JSON.stringify({
                  type: "model_unavailable",
                  model: tier.model,
                  family: "anthropic",
                  message: "No default provider configured for this project. Set one in Settings first.",
                }),
              );
              return;
            }
          }
          if (tier.baseUrl) {
            provider = new OpenAiCompatibleProvider({ baseUrl: tier.baseUrl, apiKey: undefined });
            providerKind = "openai-compatible";
          } else if (resolvedFamily) {
            const availability = await familyAvailability(config);
            if (!availability[resolvedFamily]) {
              ws.send(
                JSON.stringify({
                  type: "model_unavailable",
                  model: resolvedModel,
                  family: resolvedFamily,
                  message: resolvedFamily === "anthropic" ? "No Anthropic API key configured. Add one in Settings." : "No base URL configured. Add one in Settings.",
                }),
              );
              return;
            }
            provider = buildProvider(resolvedFamily, config);
            providerKind = resolvedFamily;
          }
          session.providerKind = providerKind;
          session.providerBaseUrl = tier.baseUrl;
          session.model = resolvedModel;
          session.maxTokens = tier.maxTokens;
          session.effort = tier.id;
          if (tier.toolBudget === "none") {
            for (const t of tools.list()) session.disabledTools.add(t.name);
          } else if (tier.toolBudget === "minimal") {
            for (const t of tools.list()) {
              if (MINIMAL_TOOL_SET.includes(t.name)) session.disabledTools.delete(t.name);
              else session.disabledTools.add(t.name);
            }
          } else {
            session.disabledTools.clear();
          }
          sendToolsStatus();
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
          sendToolsStatus();
        } else if (msg.type === "tools_status") {
          sendToolsStatus();
        } else if (msg.type === "set_plan_mode" && typeof msg.enabled === "boolean") {
          // Same gate as /plan in the CLI (see loop.ts's runOneToolCall):
          // while on, only read-only tools and exit_plan_mode run. Pushed
          // as a status update immediately, not just on the next turn's
          // ui.setStatus — the client shouldn't have to send a message
          // first to see the toggle actually took effect.
          session.planMode = msg.enabled;
          adapter.setStatus({
            tokens: session.usage.inputTokens + session.usage.outputTokens,
            costUsd: session.costUsd,
            model: session.model,
            planMode: session.planMode,
          });
        }
      }
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

await initTracing();

httpServer.listen(PORT, () => {
  // Log the REAL bound port, not the requested one — with PORT=0 (used by
  // the e2e test suite to get a genuinely free, OS-assigned port instead
  // of guessing an unused one in a fixed range) they're different, and
  // spawn-server.ts's waitForServerReady parses this exact line to learn
  // which port the server actually ended up on.
  const boundPort = (httpServer.address() as { port: number }).port;
  console.log(`finanfa-code-web server listening on http://localhost:${boundPort} (default workspace: ${DEFAULT_CWD})`);
});
