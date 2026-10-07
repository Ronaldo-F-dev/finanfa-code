import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle, runCompactCommand, isLoopGuardStopMessage } from "@finanfa/core/src/core/loop.js";
import { rewindSession } from "@finanfa/core/src/core/rewind.js";
import { APPROVAL_CATEGORIES, type ApprovalCategory } from "@finanfa/core/src/permissions/categories.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager, type PermissionManagerOptions } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { loadHooksConfig } from "@finanfa/core/src/hooks/config.js";
import { resolveTrust } from "@finanfa/core/src/core/trust-gate.js";
import { McpClientManager, MCP_TOOL_PREFIX } from "@finanfa/core/src/mcp/client-manager.js";
import { loadMcpServers } from "@finanfa/core/src/mcp/config.js";
import { MCP_CATALOG } from "./mcp-catalog.js";
import { loadSkills, formatSkillIndex, writeSkill, deleteSkill } from "@finanfa/core/src/skills/loader.js";
import {
  loadMemories,
  formatMemoryIndex,
  writeMemory,
  deleteMemory,
  type MemoryType,
} from "@finanfa/core/src/memory/loader.js";
import { formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { formatScopedInstructions } from "@finanfa/core/src/core/scoped-instructions.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig, saveGlobalConfig, updateGlobalConfig, thinkingBudgetTokensFromConfig, resolveToolSearchEnabled, resolveLocalModelLeanEnabled, type FinanfaConfig } from "@finanfa/core/src/core/config.js";
import { CONFIG_KEYS, SECRET_KEYS, maskSecret } from "@finanfa/core/src/commands/builtin.js";
import {
  baseSystemPromptFor,
  selectProvider,
  connectMcpServers,
  parseApiKeys,
  isLocalProviderConfig,
  ensureConfiguredLocalTextModel,
  ensureLocalTextModelForSwitch,
  loadStartupContext,
  registerSkillAndMemoryTools,
} from "@finanfa/core/src/app.js";
import { isEffortLevel } from "@finanfa/core/src/core/effort-level.js";
import { detectLocalProviders } from "@finanfa/core/src/core/local-providers.js";
import { CLOUD_PROVIDERS, cloudApiKey, cloudProviderForBaseUrl } from "@finanfa/core/src/core/cloud-providers.js";
import {
  isDockerModelRunnerAvailable,
  listDockerModels,
  searchDockerModels,
  pullDockerModel,
  deleteDockerModel,
  purgeDockerModels,
} from "@finanfa/core/src/core/docker-models.js";
import { isOllamaAvailable, listOllamaModels, pullOllamaModel, deleteOllamaModel } from "@finanfa/core/src/core/ollama-models.js";
import { EFFORT_TIERS, getEffortTier, isDefaultProviderTier, MINIMAL_TOOL_SET, OLLAMA_BASE_URL, pickModelForTier, type EffortTier, type LocalModelInfo } from "@finanfa/core/src/core/effort-tiers.js";
import { AnthropicProvider } from "@finanfa/core/src/providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "@finanfa/core/src/providers/openai-compatible-provider.js";
import type { LlmProvider, NeutralImage, ToolContext, ToolDefinition } from "@finanfa/core/src/core/types.js";
import type { PermissionDecision } from "@finanfa/core/src/permissions/config.js";
import { PRICING } from "@finanfa/core/src/core/pricing.js";
import { createWebUiAdapter } from "./web-ui-adapter.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";
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
import { registerMatrixChannelRoutes } from "./channels-matrix.js";
import { registerLineChannelRoutes } from "./channels-line.js";
import { registerFeishuChannelRoutes } from "./channels-feishu.js";
import { registerTeamsChannelRoutes } from "./channels-teams.js";
import { registerChannelsConfigRoutes, applyPersistedChannelSecrets, getPublicTunnelUrl, setPublicTunnelUrl } from "./channels-config-api.js";
import { checkRequestHost, checkWebSocketOrigin, hostnameOf, isLoopbackBind, parseAllowedOrigins, resolveWorkspaceFile, type OriginPolicy } from "./security.js";
import { startCloudflareTunnel } from "./cloudflare-tunnel.js";
import { parseWebUsers, authenticateBearerToken, authenticateWebSocketRequest } from "./auth.js";
import { SessionTokenStore, defaultSessionStorePath } from "./session-token-store.js";
import { loadUserStore, createUser, verifyUserPassword } from "./user-store.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
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
/** Session tokens issued by POST /api/auth/login or a completed OIDC login — see session-token-store.ts. Persisted to disk (~/.finanfa-code/web-sessions.json) so a server restart doesn't force every logged-in user to log in again; restore() below reloads whatever hadn't expired yet. Always constructed; only ever consulted when GATEWAY_ENABLED. */
const AUTH_SESSIONS = new SessionTokenStore(defaultSessionStorePath());
await AUTH_SESSIONS.restore();
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

/**
 * Address the server listens on. Loopback by default: this server drives an agent with shell and
 * file tools, so it must not be reachable from the network unless that is asked for. A deployment
 * (Docker, Fly, Render) sets FINANFA_WEB_HOST=0.0.0.0 and puts gateway auth in front.
 */
const BIND_HOST = process.env.FINANFA_WEB_HOST ?? "127.0.0.1";
const ORIGIN_POLICY: OriginPolicy = {
  loopbackBound: isLoopbackBind(BIND_HOST),
  allowedOrigins: parseAllowedOrigins(process.env.FINANFA_ALLOWED_ORIGINS),
  extraHostnames: () => {
    const tunnel = getPublicTunnelUrl();
    return tunnel ? [hostnameOf(new URL(tunnel).host) ?? ""] : [];
  },
};

const app = express();
// DNS-rebinding guard, before anything else: see checkRequestHost.
app.use((req, res, next) => {
  if (checkRequestHost(req.headers.host, ORIGIN_POLICY)) {
    next();
    return;
  }
  res.status(403).json({ error: "Unexpected Host header. Add this server's public origin to FINANFA_ALLOWED_ORIGINS." });
});
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

const startupConfig = await loadConfig(DEFAULT_CWD);
applyPersistedChannelSecrets(startupConfig);
// Once per process, not per-connection/per-session — see
// ensureConfiguredLocalTextModel's own header comment.
await ensureConfiguredLocalTextModel(startupConfig, { writeSystem: (s) => console.log(s), writeError: (s) => console.error(s) });
registerSlackChannelRoutes(app, DEFAULT_CWD);
registerTelegramChannelRoutes(app, DEFAULT_CWD);
registerDiscordChannelRoutes(app, DEFAULT_CWD);
registerWhatsappChannelRoutes(app, DEFAULT_CWD);
registerSmsChannelRoutes(app, DEFAULT_CWD);
registerVoiceChannelRoutes(app, DEFAULT_CWD);
registerMatrixChannelRoutes(app, DEFAULT_CWD);
registerLineChannelRoutes(app, DEFAULT_CWD);
registerFeishuChannelRoutes(app, DEFAULT_CWD);
registerTeamsChannelRoutes(app, DEFAULT_CWD);

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
  if (!baseUrl) throw new Error("openai-compatible requires a base URL, checked by the caller via familyAvailability first.");
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
const LOGIN_RATE_LIMITER = new LoginRateLimiter();

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "username and password are both required." });
    return;
  }
  LOGIN_RATE_LIMITER.pruneExpired();
  const retryAfterMs = LOGIN_RATE_LIMITER.retryAfterMs(req.ip ?? "unknown", username);
  if (retryAfterMs > 0) {
    res.status(429).set("Retry-After", String(Math.ceil(retryAfterMs / 1000))).json({ error: "Too many failed login attempts. Try again later." });
    return;
  }
  if (!(await verifyUserPassword(username, password))) {
    LOGIN_RATE_LIMITER.recordFailure(req.ip ?? "unknown", username);
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  LOGIN_RATE_LIMITER.recordSuccess(req.ip ?? "unknown", username);
  res.json({ token: await AUTH_SESSIONS.issue(username), user: username });
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
      res.status(400).json({ error: "Unknown, expired, or already-used state, start the login again." });
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
      const sessionToken = await AUTH_SESSIONS.issue(userInfoResult.username);
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

// Channel credentials (bot tokens, signing secrets) are read and WRITTEN here, so these routes must
// sit behind the gate above — registered before it, anyone could overwrite a channel's token and take
// the bot over even with gateway auth on. The channels' own inbound webhooks stay registered earlier
// (they carry their own signature verification, not a bearer token).
registerChannelsConfigRoutes(app);

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
    // DeepSeek, Grok and Gemini: a fixed lineup per provider, like Claude's, usable once that provider's key is saved.
    ...CLOUD_PROVIDERS.flatMap((p) =>
      p.models.map((id) => ({ id, family: "openai-compatible" as const, configured: Boolean(cloudApiKey(p, config)), baseUrl: p.baseUrl, provider: p.label })),
    ),
    ...localModels.map((m) => ({ id: `${m.source}: ${m.id}`, family: "openai-compatible" as const, configured: true, baseUrl: m.baseUrl, localModelId: m.id })),
  ];
  // localServices lists models the user has a launch command for, whether or
  // not a server currently happens to be serving one — detectLocalProviders()
  // above only reports what's live right now, so a configured-but-not-running
  // model (e.g. switching from the 1.7B default to the 4B) would otherwise never
  // appear for the user to pick. Skip any already surfaced by the live probe or
  // as the active default so the same model isn't listed twice.
  //
  // Real, reported bug: a live-probed local model's `id` is prefixed with its
  // source ("ollama: medgemma:4b"), not the bare model name — but a
  // localServices config key IS the bare name ("medgemma:4b"), the same value
  // that live-probed entry exposes as `localModelId`. Checking membership by
  // `id` alone never matched, so the same model was pushed a second time (as
  // a separate `local`/`running: false` entry) whenever it was both actually
  // running AND still listed in config.localServices — the mobile client then
  // showed two checked rows for one active model, since each one independently
  // matches `sessionInfo.model` via its own `localModelId ?? id`.
  const alreadyListed = new Set(
    models.flatMap((m) => {
      const localModelId = (m as { localModelId?: string }).localModelId;
      return localModelId ? [m.id, localModelId] : [m.id];
    }),
  );
  for (const modelName of Object.keys(config.localServices ?? {})) {
    if (alreadyListed.has(modelName)) continue;
    models.push({ id: modelName, family: "openai-compatible" as const, configured: true, local: true, running: false } as (typeof models)[number] & { local: boolean; running: boolean });
  }
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
/** Every model already usable on this machine: what Ollama has installed, plus whatever other local runtime answers right now. */
async function gatherLocalModels(): Promise<LocalModelInfo[]> {
  const found: LocalModelInfo[] = [];
  if (await isOllamaAvailable().catch(() => false)) {
    for (const m of await listOllamaModels().catch(() => [])) found.push({ name: m.name, baseUrl: OLLAMA_BASE_URL, size: m.size, supportsTools: m.supportsTools });
  }
  for (const m of await detectLocalProviders().catch(() => [])) {
    if (m.source !== "Ollama") found.push({ name: m.id, baseUrl: m.baseUrl });
  }
  return found;
}

app.get("/api/effort-tiers", async (req, res) => {
  const cwd = await resolveCwd(req.query.project as string | undefined).catch(() => DEFAULT_CWD);
  const config = await loadConfig(cwd);
  const { defaultModel } = selectProvider(config);
  const localModels = await gatherLocalModels();
  const installedNames = new Set(localModels.map((m) => m.name));
  res.json({
    tiers: EFFORT_TIERS.map((t) => {
      if (t.pickLocal) {
        // Never a download: the level uses a model that is already here, or is unavailable.
        const picked = pickModelForTier(t.id, localModels);
        return { ...t, model: picked?.name ?? "", installed: Boolean(picked), unavailable: !picked };
      }
      return {
        ...t,
        model: isDefaultProviderTier(t) ? (defaultModel ?? t.model) : t.model,
        installed: t.ollamaModel ? installedNames.has(t.ollamaModel) : true,
      };
    }),
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

/** Records which tool calls this one turn got denied — see buildTurnContext's createPermissions hook. loop.ts's dispatch never fires writeToolCall/writeToolResult for a "deny" decision at all (it returns before either), so this is the only way POST /api/turn can report "a tool call needed a decision this stateless request couldn't make" instead of silently returning a final answer that skipped a step. */
class RecordingPermissionManager extends PermissionManager {
  readonly deniedTools: string[] = [];
  override async check(tool: ToolDefinition, input: unknown, ctx: ToolContext, toolCallId?: string): Promise<PermissionDecision> {
    const decision = await super.check(tool, input, ctx, toolCallId);
    if (decision === "deny") this.deniedTools.push(tool.name);
    return decision;
  }
}

/**
 * A UIAdapter for POST /api/turn: nothing here streams anywhere (the whole
 * point of this endpoint is a single blocking JSON response), so every
 * hook just accumulates into plain arrays/strings the route reads back
 * once runTurn resolves. askUser is never expected to actually be called —
 * both resolveTrust and PermissionManager are wired with nonInteractive:
 * true for this endpoint (see buildTurnContext), so neither ever prompts —
 * but it fails safe (denies) rather than hanging if some new code path
 * ever did call it.
 */
function createHeadlessUiAdapter(): { adapter: UIAdapter; collected: { text: string; systemMessages: string[]; errors: string[]; toolCalls: { name: string; riskLevel: string }[] } } {
  const collected = { text: "", systemMessages: [] as string[], errors: [] as string[], toolCalls: [] as { name: string; riskLevel: string }[] };
  const adapter: UIAdapter = {
    writeAssistantDelta(text) {
      collected.text += text;
    },
    endAssistantMessage() {},
    writeBanner() {},
    writeSystem(text) {
      collected.systemMessages.push(text);
    },
    writeError(text) {
      collected.errors.push(text);
    },
    writeToolCall(info) {
      collected.toolCalls.push({ name: info.toolName, riskLevel: info.riskLevel });
    },
    setStatus() {},
    getStatus: () => undefined,
    setCommands() {},
    setBusy() {},
    async askUser() {
      return "n";
    },
    close() {},
  };
  return { adapter, collected };
}

const DEFAULT_TURN_TIMEOUT_MS = 180_000; // 3 minutes — a turn with several tool calls can legitimately run long, but an HTTP client (n8n's own default request timeout) needs a bound well inside its own
const MAX_TURN_TIMEOUT_MS = 600_000; // 10 minutes — generous ceiling; a caller wanting longer should poll a resumed session instead of holding one HTTP connection open indefinitely

/**
 * The REST, single-shot counterpart to the WS protocol's real-time turn
 * streaming — for callers like n8n's HTTP Request node that just want to
 * POST a prompt and get the final answer back, not speak WebSocket. Runs
 * exactly one runTurn() call (the same function/loop the WS handler above
 * calls) against a session built by the exact same buildTurnContext used
 * for every WS connection, then returns once it's done. See
 * buildTurnContext's nonInteractive doc for how a permission "ask" is
 * handled here (denied, not hung) since there's no live client to answer it
 * mid-request.
 */
app.post("/api/turn", async (req, res) => {
  const body = req.body as {
    message?: unknown;
    project?: unknown;
    session?: unknown;
    model?: unknown;
    family?: unknown;
    effort?: unknown;
    timeoutMs?: unknown;
  };
  if (typeof body.message !== "string" || !body.message.trim()) {
    res.status(400).json({ error: "Body must include a non-empty string `message`." });
    return;
  }
  const requestedTimeout = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? body.timeoutMs : DEFAULT_TURN_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requestedTimeout, 1000), MAX_TURN_TIMEOUT_MS);

  let cwd: string;
  try {
    cwd = await resolveCwd(typeof body.project === "string" ? body.project : undefined);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const { adapter, collected } = createHeadlessUiAdapter();
  let ctx: TurnContext;
  try {
    ctx = await buildTurnContext(cwd, {
      requestedModel: typeof body.model === "string" ? body.model : undefined,
      requestedSessionId: typeof body.session === "string" ? body.session : undefined,
      ui: adapter,
      nonInteractive: true,
      user: req.user,
      createPermissions: (o) => new RecordingPermissionManager(o),
    });
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      res.status(403).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const { session, config } = ctx;
  let provider = ctx.provider;
  let providerKind = ctx.providerKind;
  const { tools } = ctx;
  const permissions = ctx.permissions as RecordingPermissionManager;

  // Optional effort-tier override, reusing the exact same resolution the
  // WS "set_effort" handler above uses (getEffortTier/isDefaultProviderTier/
  // selectProvider/buildProvider) — not a second guess at what "high"/a
  // local tier's baseUrl/family/model/toolBudget mean. A plain `model`
  // (with no `effort`) is instead handled by buildTurnContext itself, the
  // same way the WS handler's `?model=` connect param already is.
  if (typeof body.effort === "string") {
    const tier = getEffortTier(body.effort);
    if (!tier) {
      res.status(400).json({ error: `Unknown effort level: ${body.effort}` });
      return;
    }
    let resolvedModel = tier.model;
    let resolvedFamily = tier.family;
    if (isDefaultProviderTier(tier)) {
      try {
        const selected = selectProvider(config);
        resolvedModel = selected.defaultModel;
        resolvedFamily = selected.kind === "openai-compatible" ? "openai-compatible" : "anthropic";
      } catch {
        res.status(400).json({ error: "No default provider configured for this project." });
        return;
      }
    }
    if (tier.baseUrl) {
      provider = new OpenAiCompatibleProvider({ baseUrl: tier.baseUrl, apiKey: undefined });
      providerKind = "openai-compatible";
    } else if (resolvedFamily) {
      const availability = await familyAvailability(config);
      if (!availability[resolvedFamily]) {
        res.status(400).json({ error: `Effort level ${body.effort} needs ${resolvedFamily}, which isn't configured on this server.` });
        return;
      }
      provider = buildProvider(resolvedFamily, config);
      providerKind = resolvedFamily;
    }
    session.providerKind = providerKind;
    session.providerBaseUrl = tier.baseUrl;
    session.model = resolvedModel;
    const localSwitch = await ensureLocalTextModelForSwitch(config, resolvedModel, adapter);
    if (localSwitch.handled && !localSwitch.ok) {
      res.status(502).json({
        error: `Couldn't switch to effort level ${body.effort} (${resolvedModel}): ${
          localSwitch.status.state === "start-failed" ? localSwitch.status.message : "the local service switch failed."
        }`,
      });
      return;
    }
    permissions.setProvider(provider);
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
  }

  // Same abort mechanism the WS "interrupt" message already uses (see
  // handleConnection above) — timing out here doesn't leave the turn
  // running invisibly against the provider/tools after the HTTP response
  // is sent, it actually stops it.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const controller of session.activeAbortControllers) controller.abort();
  }, timeoutMs);
  try {
    await runTurn(session, provider, adapter, tools, permissions, body.message);
  } catch (err) {
    clearTimeout(timer);
    res.status(502).json({ error: `Turn failed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  clearTimeout(timer);
  await session.persist().catch((err) => collected.errors.push(`Failed to save session: ${err instanceof Error ? err.message : err}`));

  if (timedOut) {
    res.status(408).json({
      error: `Turn exceeded its ${timeoutMs}ms timeout and was aborted.`,
      sessionId: session.id,
      partialText: collected.text || undefined,
    });
    return;
  }

  const last = session.messages.at(-1);
  const stoppedByGuard = last?.role === "assistant" && typeof last.content === "string" && isLoopGuardStopMessage(last.content);
  res.json({
    sessionId: session.id,
    model: session.model,
    providerKind,
    effort: session.effort,
    effortLevel: session.effortLevel,
    text: collected.text,
    toolCalls: collected.toolCalls,
    // Tool calls this turn wanted to run but that hit an "ask"-tier
    // decision with no live client to answer it — this endpoint's
    // nonInteractive policy denies them rather than hanging (see
    // buildTurnContext/PermissionManager's own nonInteractive doc). The
    // model still got a "User declined to run this tool." result for each
    // and may have adapted its answer around that; this list is so a
    // caller (e.g. an n8n workflow) can tell that happened instead of
    // silently trusting a final answer that skipped a step.
    deniedTools: permissions.deniedTools,
    stoppedByStepLimitGuard: stoppedByGuard,
    systemMessages: collected.systemMessages,
    errors: collected.errors,
  });
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
  res.json({ ok: true, note: "Saved. Existing open chats keep their current provider/model, start a new chat to pick up the change." });
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
// subfolder specifically. Unlike the agent's own file tools, this is
// reachable without a permission prompt (and without auth unless the
// gateway is on), so it is confined to the project directory.
app.get("/api/workspace-file", async (req, res) => {
  const relPath = req.query.path;
  if (typeof relPath !== "string" || relPath.length === 0) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    const cwd = await resolveCwd(typeof req.query.project === "string" ? req.query.project : undefined);
    // Confined to the project (symlinks resolved, credential locations refused) — see resolveWorkspaceFile.
    const fullPath = await resolveWorkspaceFile(cwd, relPath);
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
// Browsers let any web page open a WebSocket to any host, so the handshake's Origin is checked —
// otherwise a random site open in the same browser could drive the agent. See checkWebSocketOrigin.
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  verifyClient: (info, done) => {
    if (checkWebSocketOrigin(info.origin, info.req.headers.host, ORIGIN_POLICY) && checkRequestHost(info.req.headers.host, ORIGIN_POLICY)) {
      done(true);
      return;
    }
    done(false, 403, "Forbidden origin");
  },
});

wss.on("connection", (ws: WebSocket, req) => {
  const url = req.url ?? "";
  if (GATEWAY_ENABLED) {
    const user = authenticateWebSocketRequest(WEB_USERS ?? new Map(), AUTH_SESSIONS, url, req.headers.authorization);
    if (!user) {
      ws.close(4001, "Missing or invalid ?token= or Authorization: Bearer header");
      return;
    }
    void handleConnection(ws, url, user);
    return;
  }
  void handleConnection(ws, url, undefined);
});

/** Thrown by buildTurnContext when GATEWAY_ENABLED and a resumed session belongs to a different user than the one making this request — each caller translates it into its own "forbidden" response (the WS handler: close 4003; POST /api/turn: 403). */
class SessionOwnershipError extends Error {}

interface TurnContext {
  session: AgentSession;
  provider: LlmProvider;
  providerKind: string;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  browser: BrowserManager;
  config: FinanfaConfig;
  model: string;
  needsAuth: string[];
}

/**
 * Builds everything a single agent turn needs against one project directory
 * — config, provider, the full tool registry (builtins, skills, memories,
 * MCP, plugins), and a PermissionManager wired up the same way — for every
 * real entry point that runs a turn (the WS handler below, and POST
 * /api/turn). One construction path so a change to what a session needs
 * (a new builtin tool, a new project-instructions file, ...) only has to
 * happen once; this is exactly the setup handleConnection used to inline
 * directly, extracted unchanged so POST /api/turn doesn't need a second,
 * drifting copy of it.
 *
 * `nonInteractive` controls both the folder-trust gate and permission
 * "ask"-tier prompts (see resolveTrust/PermissionManager's own docs): pass
 * true for a caller with no live human to answer a mid-request prompt (a
 * stateless REST request can't); the WS path always has a connected
 * browser that can, so it passes false, exactly as it did before this was
 * extracted.
 */
async function buildTurnContext(
  cwd: string,
  opts: {
    requestedModel?: string;
    requestedSessionId?: string;
    ui: UIAdapter;
    nonInteractive: boolean;
    user?: string;
    /** Overrides how the PermissionManager is constructed — used only by POST /api/turn, to swap in a subclass that records which tool calls got denied (see RecordingPermissionManager) without duplicating the config/hooks/trust resolution above. Defaults to a plain `new PermissionManager(...)`, exactly as before this hook existed. */
    createPermissions?: (managerOpts: PermissionManagerOptions) => PermissionManager;
  },
): Promise<TurnContext> {
  const config = await loadConfig(cwd);
  const initial = selectProvider(config);
  const defaultModel = initial.defaultModel;
  // Mutable — switching to a model from a different provider family (see
  // "set_model" below) swaps both, not just the model string.
  let provider: LlmProvider = initial.provider;
  let providerKind: string = initial.kind;

  const tools = new ToolRegistry();
  registerBuiltins(tools, { sandbox: config.sandbox, config });

  const { skills, memories, agentTypes, projectInstructions, scopedInstructions, designContract } = await loadStartupContext(cwd);

  registerSkillAndMemoryTools(tools, skills, memories, cwd);

  const localModelLeanEnabled = resolveLocalModelLeanEnabled(config, isLocalProviderConfig(config));
  const systemPrompt =
    baseSystemPromptFor(localModelLeanEnabled) +
    formatSkillIndex(skills) +
    formatMemoryIndex(memories) +
    formatProjectInstructions(projectInstructions) +
    formatScopedInstructions(scopedInstructions);

  // The session's own (readonly) model wins on resume — a saved session
  // keeps whatever model it was created with, same as the CLI has no
  // /model command to change one mid-session either.
  let session: AgentSession;
  if (opts.requestedSessionId) {
    try {
      session = await AgentSession.resume(cwd, opts.requestedSessionId, systemPrompt);
      // Auth on, session already has a different owner: refuse the resume
      // outright rather than silently handing one user's conversation
      // history to another. A session with no owner recorded yet (predates
      // this field, or was created by a non-web entry point sharing this
      // project) is treated as unclaimed — resuming it adopts it below.
      if (GATEWAY_ENABLED && session.ownerUser && session.ownerUser !== opts.user) {
        throw new SessionOwnershipError(`Session "${opts.requestedSessionId}" belongs to a different user.`);
      }
    } catch (err) {
      if (err instanceof SessionOwnershipError) throw err;
      opts.ui.writeError(
        `Could not resume session "${opts.requestedSessionId}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
      );
      session = new AgentSession({ cwd, model: opts.requestedModel ?? defaultModel, systemPrompt });
    }
  } else {
    session = new AgentSession({ cwd, model: opts.requestedModel ?? defaultModel, systemPrompt });
  }
  if (GATEWAY_ENABLED) session.ownerUser = opts.user;
  if (session.thinkingBudgetTokens === undefined) session.thinkingBudgetTokens = thinkingBudgetTokensFromConfig(config);
  session.toolSearchEnabled = resolveToolSearchEnabled(config);
  session.localModelLeanEnabled = localModelLeanEnabled;
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
    const cloud = cloudProviderForBaseUrl(session.providerBaseUrl);
    provider = new OpenAiCompatibleProvider({ baseUrl: session.providerBaseUrl, apiKey: cloud ? cloudApiKey(cloud, config) : undefined });
    providerKind = "openai-compatible";
  } else if (session.providerKind && session.providerKind !== providerKind) {
    const family: ProviderFamily = session.providerKind === "openai-compatible" ? "openai-compatible" : "anthropic";
    const availability = await familyAvailability(config);
    if (availability[family]) {
      provider = buildProvider(family, config);
      providerKind = family;
    } else {
      opts.ui.writeError(
        `This session was last using a ${family} model, but ${family} isn't configured, falling back to the default (${providerKind}). Switch models or update Settings to restore it.`,
      );
    }
  }

  // Same folder-trust gate the CLI applies (see core/trust-gate.ts): a
  // project's own .finanfa-code/settings.json can define permission
  // rules and hooks that run automatically — including a PreToolUse hook
  // that auto-approves every tool call — so it must never take effect
  // just because the web server happened to be pointed at that
  // directory. resolveTrust prompts over the same askUser round-trip
  // permission prompts already use; nonInteractive fails closed instead
  // (never calling opts.ui.askUser at all) for a caller with no live
  // client to answer it, e.g. POST /api/turn — same as the CLI's
  // --non-interactive and the ACP bridge.
  const trusted = await resolveTrust(cwd, opts.ui, opts.nonInteractive);
  const permissionConfig = await loadPermissionConfig(cwd, trusted);
  const hooksConfig = await loadHooksConfig(cwd, trusted);
  const permissions = (opts.createPermissions ?? ((o: PermissionManagerOptions) => new PermissionManager(o)))({
    config: permissionConfig,
    ui: opts.ui,
    hooksConfig,
    provider,
    nonInteractive: opts.nonInteractive,
  });

  // Plugins are arbitrary imported JS, not inert config like hooks —
  // gated on the same folder-trust decision above, not loaded before it.
  // The web UI has no slash-command surface yet, so a plugin's
  // registerCommands (if any) is a no-op here — only registerTools takes
  // effect, same as it would with any other tool-provider.
  const plugins = trusted ? await loadPlugins(cwd, tools, new CommandRegistry()) : [];
  if (plugins.length > 0) console.log(`[${cwd}] Plugins: ${plugins.join(", ")}`);

  const mcp = new McpClientManager();
  const browser = new BrowserManager();
  const { needsAuth } = await connectMcpServers(cwd, mcp, opts.ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  registerStatefulBuiltins(tools, { provider, permissions, ui: opts.ui, model, cwd, browser, designContract: designContract.content, systemPrompt, agentTypes });

  return { session, provider, providerKind, tools, permissions, mcp, browser, config, model, needsAuth };
}

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

  // Messages sent before the main handler below exists — it's only attached
  // once buildTurnContext finishes (seconds of config, tool registration and
  // MCP setup) — used to be silently dropped: the web UI enables its
  // composer the moment the socket opens, so a fast first message vanished
  // with no error and no reply, and a scripted/Flutter client doing the same
  // hit the identical hole. Queue them here, then replay in arrival order
  // once the real handler is attached. permission_response is already
  // handled by the listener above; replaying it there is a harmless no-op.
  const earlyMessages: Buffer[] = [];
  let mainHandlerAttached = false;
  ws.on("message", (raw: Buffer) => {
    if (!mainHandlerAttached) earlyMessages.push(raw);
  });

  const params = new URL(url, "http://localhost").searchParams;
  const requestedModel = params.get("model") ?? undefined;
  const requestedSessionId = params.get("session") ?? undefined;
  const requestedProjectId = params.get("project") ?? undefined;

  try {
    const CWD = await resolveCwd(requestedProjectId);
    let ctx: TurnContext;
    try {
      ctx = await buildTurnContext(CWD, { requestedModel, requestedSessionId, ui: adapter, nonInteractive: false, user });
    } catch (err) {
      if (err instanceof SessionOwnershipError) {
        adapter.writeError(err.message);
        ws.close(4003, "Session belongs to a different user");
        return;
      }
      throw err;
    }
    const { session, config, model, tools, mcp, browser } = ctx;
    // Mutable — switching to a model from a different provider family (see
    // "set_model" below) swaps both, not just the model string.
    let provider = ctx.provider;
    let providerKind = ctx.providerKind;
    const permissions = ctx.permissions;
    const needsAuthSet = new Set(ctx.needsAuth);

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
          effortLevel: session.effortLevel,
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

    /** Which groups of tool calls are approved without asking, and whether an administrator's policy forbids changing that. */
    function sendAutoApprove(): void {
      ws.send(JSON.stringify({ type: "auto_approve", settings: permissions.getAutoApprove(), forbidden: permissions.isAutoApproveForbidden(), categories: APPROVAL_CATEGORIES }));
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
    // Real, reported bug: the Tools panel only ever requested tools_status
    // once, right when it mounted (see ToolsPanel.tsx) — if the socket
    // wasn't yet WebSocket.OPEN at that exact instant (useAgentSocket's
    // send() silently no-ops otherwise), that request just vanished and
    // nothing ever retried it, leaving the panel stuck on "Loading…"
    // forever until it was closed and reopened. Pushed here unconditionally
    // on every connection, same as sendMcpStatus() right above, so the
    // client already has real tool data by the time anyone opens the panel.
    sendToolsStatus();
    sendAutoApprove();
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
        // A restore asked for mid-turn is refused on the spot. Queued like everything else it would run once the turn
        // is over — and quietly rewind past the very message that was just answered, which nobody asked for.
        if (peek.type === "rewind" && turnInFlight) {
          adapter.writeError("A turn is in progress, wait for it to finish (or interrupt) before restoring an earlier point.");
          return;
        }
      } catch {
        // Malformed JSON — falls through to the queue below, which already
        // reports this the same way it always has.
      }
      messageQueue = messageQueue.then(handleMessage).catch((err) => {
        console.error(`Unhandled error handling a WS message for session ${session.id}:`, err);
      });

      // Each branch of the old if/else-if chain below is now its own named
      // function — that single ~440-line closure was flagged by static
      // analysis as excessive Cognitive Complexity (the same issue, and the
      // same fix, already applied to message-handler.ts, the VS Code
      // extension's own mirror of this handler — see its own comment on
      // why). A `switch` on msg.type dispatches to them; each still starts
      // with the same guard the original `if (msg.type === "X" && <guard>)`
      // had, so an ill-shaped message for a matching type is silently
      // dropped exactly as before (the old chain never reached a later
      // `else if` once msg.type itself matched one, guard or not).
      async function handleUserMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (typeof msg.text !== "string") return;
        if (turnInFlight) {
          adapter.writeError("A turn is already in progress, wait for it to finish (or interrupt) before sending another message.");
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
              "cross-check facts, fetch pages for real detail rather than trusting a snippet) before answering, don't answer " +
              `from memory alone if search tools can verify it. Take as many search/fetch steps as genuinely useful.\n\n${msg.text}`
            : msg.text;
          let nextText: string = text;
          let nextImages = images;
          // The id the browser gave this message, recorded on the turn's checkpoint so its "restore" button can find it.
          // Only the user's own message carries one — the auto-continue turns below are not messages the user sent.
          let clientId = typeof msg.clientId === "string" && msg.clientId.length > 0 && msg.clientId.length <= 64 ? msg.clientId : undefined;
          for (let turn = 1; turn <= WEB_MAX_AUTO_CONTINUE_TURNS; turn++) {
            await runTurn(session, provider, adapter, tools, permissions, nextText, undefined, nextImages, { clientId });
            clientId = undefined;
            const last = session.messages.at(-1);
            const stoppedByGuard = last?.role === "assistant" && typeof last.content === "string" && isLoopGuardStopMessage(last.content);
            if (!stoppedByGuard || turn === WEB_MAX_AUTO_CONTINUE_TURNS) break;
            adapter.writeSystem(`(auto-continuing: cut off by the step-limit guard, turn ${turn + 1}/${WEB_MAX_AUTO_CONTINUE_TURNS})`);
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
          sendCheckpoints();
          const hadTitle = Boolean(session.title);
          await maybeGenerateTitle(session, provider);
          if (!hadTitle && session.title) sendSessionInfo();
        } catch (err) {
          adapter.writeError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          turnInFlight = false;
          await session.persist().catch((err) => adapter.writeError(`Failed to save session: ${err instanceof Error ? err.message : err}`));
        }
      }

      /** Switches a category of tool calls on or off, here and in the user's global config (so the next conversation starts the same way). */
      async function handleSetAutoApprove(msg: { type: string; [key: string]: unknown }): Promise<void> {
        const category = msg.category;
        if (typeof category !== "string" || !(APPROVAL_CATEGORIES as readonly string[]).includes(category) || typeof msg.enabled !== "boolean") return;
        if (!permissions.setAutoApprove(category as ApprovalCategory, msg.enabled)) {
          adapter.writeError("Skipping approvals is disabled by this machine's managed settings.");
          sendAutoApprove();
          return;
        }
        try {
          await updateGlobalConfig({ autoApprove: permissions.getAutoApprove() });
        } catch (err) {
          adapter.writeError(`Applied for this conversation, but could not save the setting: ${err instanceof Error ? err.message : String(err)}`);
        }
        sendAutoApprove();
      }

      /** The restore points the browser may offer: one per message the user sent in this connection (they are not kept across a reload). */
      function sendCheckpoints(): void {
        ws.send(JSON.stringify({ type: "checkpoints", checkpoints: session.checkpoints.map((c, i) => ({ number: i + 1, preview: c.preview, clientId: c.clientId })) }));
      }

      /** Restores the conversation and every edit/write-tool file change to right before checkpoint `msg.checkpoint`. */
      async function handleRewind(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (turnInFlight) {
          adapter.writeError("A turn is in progress, wait for it to finish (or interrupt) before restoring an earlier point.");
          return;
        }
        turnInFlight = true; // same guard compaction uses: a message arriving mid-rewind would append to an array being cut
        try {
          // Read before rewinding: the checkpoint is gone afterwards.
          const clientId = typeof msg.checkpoint === "number" ? session.checkpoints[msg.checkpoint - 1]?.clientId : undefined;
          const result = typeof msg.checkpoint === "number" ? await rewindSession(session, msg.checkpoint) : undefined;
          if (!result) {
            adapter.writeError("That restore point no longer exists.");
            sendCheckpoints();
            return;
          }
          ws.send(JSON.stringify({ type: "rewound", checkpoint: msg.checkpoint, clientId, preview: result.preview, revertedFiles: result.revertedFiles }));
          sendCheckpoints();
        } catch (err) {
          adapter.writeError(`Could not restore: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          turnInFlight = false;
        }
      }

      function handlePermissionResponse(msg: { type: string; [key: string]: unknown }): void {
        if (typeof msg.requestId === "number" && typeof msg.answer === "string") resolvePending(msg.requestId, msg.answer);
      }

      async function handleCompact(): Promise<void> {
        if (turnInFlight) {
          adapter.writeError("A turn is already in progress, wait for it to finish (or interrupt) before compacting.");
          return;
        }
        // Held for the duration of the compaction call itself (not just
        // checked at the start) — compactSession replaces session.messages
        // wholesale, so a user_message arriving mid-compaction and
        // appending to the same array while that replacement is in flight
        // would corrupt it. Same guard user_message itself uses. The
        // actual busy/system-message/compaction sequence lives in
        // runCompactCommand (loop.ts), shared with the VS Code extension's
        // own "compact" handler — this used to be duplicated near-verbatim
        // between the two.
        turnInFlight = true;
        try {
          const result = await runCompactCommand(session, provider, {
            setBusy: (busy, label) => adapter.setBusy(busy, label),
            writeSystem: (text) => adapter.writeSystem(text),
          });
          // The client's timeline holds the old turns individually — tell
          // it to replace them with just the two-message summary now
          // actually in session.messages, same replay path a resumed
          // session's initial "history" event already uses.
          if (result.replacedMessages) {
            ws.send(JSON.stringify({ type: "history", replace: true, messages: result.replacedMessages }));
            sendCheckpoints(); // compaction cleared them: the browser must drop its restore buttons
          }
        } finally {
          turnInFlight = false;
        }
      }

      // Shared by handleSetModel/handleSetEffort below: a local-service
      // switch that ensureLocalTextModelForSwitch reports as failed
      // (start-failed) must not leave the session/UI claiming the new
      // model is active while the old local service is still the one
      // actually answering — this restores exactly what each snapshotted
      // right before attempting its own switch. The error TEXT still
      // differs per caller (model name vs. "effort level X (model)"), so
      // only the state-rollback itself is shared here, not the ws.send.
      function rollbackProviderSwitch(snapshot: {
        model: string;
        providerKind: string;
        providerBaseUrl: string | undefined;
        provider: LlmProvider;
        effort: string | undefined;
      }): void {
        session.model = snapshot.model;
        providerKind = snapshot.providerKind;
        session.providerKind = snapshot.providerKind;
        session.providerBaseUrl = snapshot.providerBaseUrl;
        provider = snapshot.provider;
        session.effort = snapshot.effort;
      }

      // Rebuilds provider/providerKind for a plain model pick (handleSetModel
      // below) — split out purely to keep that function's own Cognitive
      // Complexity down, since set_model/set_effort together were exactly
      // what the original giant if/else-if chain's complexity came from.
      // Returns false (having already sent model_unavailable) when the
      // target family isn't configured at all; true otherwise, including
      // the plain "nothing needs to change" case.
      // Shared by resolveProviderForSetModel/applyProviderForEffortTier
      // below — both need the exact same "check this family is actually
      // configured, send model_unavailable and bail out if not, otherwise
      // rebuild provider/providerKind against it" sequence, just with a
      // different model name and wording in the error. Factored out after
      // SonarCloud flagged the near-identical duplicate as New Code
      // Duplication once both existed.
      async function rebuildProviderForFamily(family: ProviderFamily, modelForError: string, noKeyMessage: string): Promise<boolean> {
        const availability = await familyAvailability(config);
        if (!availability[family]) {
          ws.send(JSON.stringify({ type: "model_unavailable", model: modelForError, family, message: noKeyMessage }));
          return false;
        }
        provider = buildProvider(family, config);
        providerKind = family;
        return true;
      }

      async function resolveProviderForSetModel(msg: { type: string; [key: string]: unknown }, hadBaseUrlOverride: boolean): Promise<boolean> {
        const family: ProviderFamily = msg.family === "openai-compatible" ? "openai-compatible" : "anthropic";
        if (typeof msg.baseUrl === "string" && msg.baseUrl) {
          // A detected local model (Ollama/LM Studio/...) — always rebuilt
          // directly against its own baseUrl, unconditionally, rather than
          // the family-change check below: two local models can both be
          // family "openai-compatible" but live at different baseUrls
          // (e.g. switching from Ollama to LM Studio), which that check
          // alone can't distinguish since it only fires on a family flip.
          // No API key — every local runtime here is unauthenticated. A cloud provider (DeepSeek, Grok, Gemini)
          // goes the same way but with its own key.
          const cloud = cloudProviderForBaseUrl(msg.baseUrl);
          const cloudKey = cloud ? cloudApiKey(cloud, config) : undefined;
          if (cloud && !cloudKey) {
            ws.send(JSON.stringify({ type: "error", text: `No ${cloud.label} API key configured. Add one in Settings to use this model.` }));
            return false;
          }
          provider = new OpenAiCompatibleProvider({ baseUrl: msg.baseUrl, apiKey: cloudKey });
          providerKind = "openai-compatible";
          return true;
        }
        // Real, reported bug: switching FROM a local model (a specific
        // baseUrl override, e.g. Ollama) back TO a normal same-family model
        // (e.g. the configured default openai-compatible provider) left
        // `provider` pointed at the OLD local baseUrl — the family hadn't
        // changed ("openai-compatible" both times), so this check never
        // fired, and only session.model was updated. The next call then
        // sent the new model's name to the old local server, which had
        // never heard of it (404). hadBaseUrlOverride forces a rebuild even
        // within the same family when switching away from one.
        if (family !== providerKind || hadBaseUrlOverride) {
          return rebuildProviderForFamily(
            family,
            msg.model as string,
            family === "anthropic"
              ? "No Anthropic API key configured. Add one in Settings to use Claude models."
              : "No base URL configured for an OpenAI-compatible provider. Add one in Settings to use this model.",
          );
        }
        return true;
      }

      // The other half of handleSetModel split out for the same reason —
      // applies the Effort-tiers-style protective tool budget when the
      // newly picked model is local-server-served, since bypassing the
      // tiers through this plain picker used to crash real machines (see
      // the comment this carries over).
      async function applyLocalToolBudgetForSetModel(msg: { type: string; [key: string]: unknown }, hadEffort: boolean): Promise<void> {
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
          const supportsTools = await lookupOllamaToolSupport(msg.model as string);
          session.disabledTools.clear();
          if (supportsTools === false) {
            for (const t of tools.list()) session.disabledTools.add(t.name);
          } else if (supportsTools === true) {
            for (const t of tools.list()) if (!MINIMAL_TOOL_SET.includes(t.name)) session.disabledTools.add(t.name);
          }
          // undefined (unknown runtime, e.g. LM Studio/llama.cpp/vLLM that
          // doesn't expose Ollama's capabilities field, or the lookup
          // itself failed) — no signal to act on, leave as-is.
          sendToolsStatus();
        } else if (hadEffort) {
          session.disabledTools.clear();
          sendToolsStatus();
        }
      }

      // Real, reported case: switching to a local model and sending one
      // message crashed the whole machine — not this project's bug in the
      // usual sense, but a real consequence of this project's own behavior:
      // every call includes the full tool list (100+ tools, several tens of
      // thousands of tokens on its own, before any conversation). A local
      // runtime (Ollama, Docker Model Runner, llama.cpp, ...) has to
      // allocate KV-cache proportional to whatever context that prompt
      // needs — on constrained hardware (no/limited GPU, modest RAM) that
      // allocation can exhaust memory badly enough to take the whole system
      // down, not just fail cleanly the way a remote API would. Warned
      // here, proactively, the moment a local model is selected — before
      // the crash, not only after it via the "context size exceeded" error
      // message. Once per connection, not once per switch — the risk is
      // exactly the same for every local model, so repeating it on every
      // single switch just becomes noise someone trying several local
      // models in a row has to scroll past.
      function warnIfLocalModel(modelName: string): void {
        if (!warnedAboutLocalModelThisConnection && session.providerBaseUrl && isLocalBaseUrl(session.providerBaseUrl)) {
          warnedAboutLocalModelThisConnection = true;
          const enabledToolCount = tools.list().filter((t) => !session.disabledTools.has(t.name)).length;
          adapter.writeSystem(
            `⚠ ${modelName} is a local model, every message sent here includes this agent's full system prompt ` +
              `and tool list (currently ${enabledToolCount} tools, tens of thousands of tokens on its own, before ` +
              "any conversation). On a machine with limited RAM/no GPU, a local runtime trying to allocate enough " +
              "context for that can exhaust memory badly enough to freeze or crash the whole system, not just fail " +
              "cleanly. If that happens, use /tools (or the Tools panel here) to disable most tools before trying " +
              "a local model again, a handful of tools is a much smaller, safer prompt than the full set.",
          );
        }
      }

      async function handleSetModel(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (typeof msg.model !== "string" || !msg.model) return;
        // Snapshot of everything this handler is about to overwrite, so a
        // local-service switch that ensureLocalTextModelForSwitch reports
        // as failed (start-failed) can be rolled back below instead of
        // leaving the session/UI claiming the new model is active while
        // the old local service is still the one actually answering — the
        // real, reported bug this closes.
        const snapshot = { model: session.model, providerKind, providerBaseUrl: session.providerBaseUrl, provider, effort: session.effort };
        const hadBaseUrlOverride = Boolean(session.providerBaseUrl);
        if (!(await resolveProviderForSetModel(msg, hadBaseUrlOverride))) return;
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
        // Real, reported gap: picking a different locally-served text
        // model (e.g. switching between several Bonsai sizes) didn't
        // start that service with the newly-picked one — only the very
        // first process-startup check ever ensured something was running.
        // A no-op unless config.localServices has an entry for msg.model.
        const localSwitch = await ensureLocalTextModelForSwitch(config, msg.model, adapter);
        if (localSwitch.handled && !localSwitch.ok) {
          // The local service switch was attempted and failed — whatever's
          // actually running at that baseUrl is still the OLD model, so
          // committing session.model/providerKind here would make the UI
          // show the new model as active while every message keeps
          // getting answered by the old one underneath it. Roll the
          // session back to what was actually working before this message
          // arrived, and tell the client the switch didn't happen instead
          // of silently acking it.
          rollbackProviderSwitch(snapshot);
          ws.send(
            JSON.stringify({
              type: "error",
              text: `Couldn't switch to ${msg.model}: ${
                localSwitch.status.state === "start-failed" ? localSwitch.status.message : "the local service switch failed."
              }`,
            }),
          );
          sendSessionInfo();
          return;
        }
        // Keeps the auto-approval classifier (if enabled) classifying
        // against the model this session actually just switched to,
        // rather than a stale provider captured at connection time.
        permissions.setProvider(provider);
        // A manual pick through this plain picker is a distinct action
        // from an effort tier (see set_effort below) — the "effort" badge
        // shouldn't keep claiming Faible/Moyen/Fort once the user has
        // overridden it by hand.
        const hadEffort = Boolean(session.effort);
        session.effort = undefined;
        await applyLocalToolBudgetForSetModel(msg, hadEffort);
        sendSessionInfo();
        warnIfLocalModel(msg.model);
      }

      // "high" has no fixed model/family of its own — it means "this
      // project's already-configured default provider", whatever that is
      // (Poolside via openai-compatible, Anthropic, ...), not a hardcoded
      // family. Resolving it wrong here would mean "high" silently
      // requiring an Anthropic key even for a project whose actual default
      // is an openai-compatible endpoint like Poolside. Returns undefined
      // (having already sent model_unavailable) when there's no default
      // provider configured at all.
      function resolveEffortTierModel(tier: EffortTier): { model: string; family: ProviderFamily | undefined } | undefined {
        if (!isDefaultProviderTier(tier)) return { model: tier.model, family: tier.family };
        try {
          const selected = selectProvider(config);
          return { model: selected.defaultModel, family: selected.kind === "openai-compatible" ? "openai-compatible" : "anthropic" };
        } catch {
          ws.send(
            JSON.stringify({
              type: "model_unavailable",
              model: tier.model,
              family: "anthropic",
              message: "No default provider configured for this project. Set one in Settings first.",
            }),
          );
          return undefined;
        }
      }

      // Split out of handleSetEffort for the same Cognitive Complexity
      // reason as resolveProviderForSetModel above. Returns false (having
      // already sent model_unavailable) when the resolved family isn't
      // configured; true otherwise, including "tier has no family of its
      // own" (nothing to rebuild).
      async function applyProviderForEffortTier(tier: EffortTier, resolvedModel: string, resolvedFamily: ProviderFamily | undefined): Promise<boolean> {
        if (tier.baseUrl) {
          provider = new OpenAiCompatibleProvider({ baseUrl: tier.baseUrl, apiKey: undefined });
          providerKind = "openai-compatible";
          return true;
        }
        if (resolvedFamily) {
          return rebuildProviderForFamily(
            resolvedFamily,
            resolvedModel,
            resolvedFamily === "anthropic" ? "No Anthropic API key configured. Add one in Settings." : "No base URL configured. Add one in Settings.",
          );
        }
        return true;
      }

      function applyToolBudgetForEffortTier(tier: EffortTier): void {
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
      }

      // How much the current model thinks (see effort-level.ts). Applies from the next message and changes nothing
      // else: not the model, not the tools. null clears it, back to the model's and the config's own behaviour.
      async function handleSetEffortLevel(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (msg.level === null) session.effortLevel = undefined;
        else if (isEffortLevel(msg.level)) session.effortLevel = msg.level;
        else return;
        sendSessionInfo();
      }

      async function handleSetEffort(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (typeof msg.level !== "string") return;
        // Shortcut past manually picking a model + remembering to strip
        // tools every time: one message picks a model, a max_tokens cap,
        // and a curated tool budget together (see effort-tiers.ts for why
        // each tier's exact settings are what they are).
        const baseTier = getEffortTier(msg.level);
        if (!baseTier) {
          ws.send(JSON.stringify({ type: "error", text: `Unknown effort level: ${msg.level}` }));
          return;
        }
        // "low" and "medium" take a model that is already installed or running here, and never offer to download one.
        let tier: EffortTier = baseTier;
        if (baseTier.pickLocal) {
          const picked = pickModelForTier(baseTier.id, await gatherLocalModels());
          if (!picked) {
            ws.send(
              JSON.stringify({
                type: "model_unavailable",
                model: baseTier.label,
                family: "openai-compatible",
                message: "No installed local model fits this level. Install one from Models (Ollama or Docker Model Runner), then pick the level again.",
              }),
            );
            return;
          }
          tier = { ...baseTier, model: picked.name, family: "openai-compatible", baseUrl: picked.baseUrl };
        }
        // Same rollback snapshot as set_model above, for the same reason —
        // a tier whose model is local-server-served can fail the switch at
        // ensureLocalTextModelForSwitch below just as easily as the plain
        // picker can.
        const snapshot = { model: session.model, providerKind, providerBaseUrl: session.providerBaseUrl, provider, effort: session.effort };
        if (tier.ollamaModel) {
          const available = await isOllamaAvailable().catch(() => false);
          const installed = available && (await listOllamaModels().catch(() => [])).some((m) => m.name === tier.ollamaModel);
          if (!installed) {
            ws.send(JSON.stringify({ type: "effort_needs_download", level: tier.id, ollamaModel: tier.ollamaModel }));
            return;
          }
        }
        const resolved = resolveEffortTierModel(tier);
        if (!resolved) return;
        if (!(await applyProviderForEffortTier(tier, resolved.model, resolved.family))) return;
        session.providerKind = providerKind;
        session.providerBaseUrl = tier.baseUrl;
        session.model = resolved.model;
        // Same local-model-switch check as the plain model picker above —
        // a no-op unless this tier's model is one of
        // config.localServices's entries.
        const localSwitch = await ensureLocalTextModelForSwitch(config, resolved.model, adapter);
        if (localSwitch.handled && !localSwitch.ok) {
          // Same rollback as set_model above: don't let the session/UI
          // claim this effort tier's model is active when the local
          // service switch it depends on actually failed.
          rollbackProviderSwitch(snapshot);
          ws.send(
            JSON.stringify({
              type: "error",
              text: `Couldn't switch to effort level ${msg.level} (${resolved.model}): ${
                localSwitch.status.state === "start-failed" ? localSwitch.status.message : "the local service switch failed."
              }`,
            }),
          );
          sendSessionInfo();
          return;
        }
        // Same as set_model above — keep the classifier on the provider
        // this effort tier actually switched to.
        permissions.setProvider(provider);
        session.maxTokens = tier.maxTokens;
        session.effort = tier.id;
        applyToolBudgetForEffortTier(tier);
        sendToolsStatus();
        sendSessionInfo();
      }

      async function handleMcpConnect(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (typeof msg.name !== "string") return;
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
          if (config.transport !== "stdio") adapter.writeSystem(`Connecting to "${msg.name}", if it requires authorization, a browser tab will open on the server...`);
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
      }

      async function handleMcpEnableDisable(msg: { type: string; [key: string]: unknown }): Promise<void> {
        if (typeof msg.name !== "string") return;
        if (!mcp.connectedServers().includes(msg.name)) {
          adapter.writeError(`No connected MCP server named "${msg.name}".`);
        } else if (msg.type === "mcp_enable") {
          session.disabledMcpServers.delete(msg.name);
        } else {
          session.disabledMcpServers.add(msg.name);
        }
        await sendMcpStatus();
      }

      async function handleMcpReload(): Promise<void> {
        await reloadMcpTools();
        adapter.writeSystem("MCP tools reloaded.");
        await sendMcpStatus();
      }

      function handleSetToolEnabled(msg: { type: string; [key: string]: unknown }): void {
        if (typeof msg.name !== "string" || typeof msg.enabled !== "boolean") return;
        if (msg.enabled) session.disabledTools.delete(msg.name);
        else session.disabledTools.add(msg.name);
        sendToolsStatus();
      }

      function handleSetPlanMode(msg: { type: string; [key: string]: unknown }): void {
        if (typeof msg.enabled !== "boolean") return;
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

      async function handleMessage(): Promise<void> {
        let msg: { type: string; [key: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          adapter.writeError("Received a malformed message (not valid JSON).");
          return;
        }

        switch (msg.type) {
          case "user_message":
            return handleUserMessage(msg);
          case "permission_response":
            return handlePermissionResponse(msg);
          case "compact":
            return handleCompact();
          case "rewind":
            return handleRewind(msg);
          case "set_auto_approve":
            return handleSetAutoApprove(msg);
          case "set_model":
            return handleSetModel(msg);
          case "set_effort":
            return handleSetEffort(msg);
          case "set_effort_level":
            return handleSetEffortLevel(msg);
          case "mcp_status":
            await sendMcpStatus();
            return;
          case "mcp_connect":
            return handleMcpConnect(msg);
          case "mcp_enable":
          case "mcp_disable":
            return handleMcpEnableDisable(msg);
          case "mcp_reload":
            return handleMcpReload();
          case "set_tool_enabled":
            return handleSetToolEnabled(msg);
          case "tools_status":
            sendToolsStatus();
            return;
          case "set_plan_mode":
            return handleSetPlanMode(msg);
          default:
            return;
        }
      }
    });

    // See the early-message queue near the top of handleConnection: the main
    // handler above is now attached, so replay everything that arrived while
    // it didn't exist yet. Synchronous and in arrival order — no later
    // message can interleave with the replay.
    mainHandlerAttached = true;
    for (const raw of earlyMessages.splice(0)) ws.emit("message", raw);

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
        if (session.messages.length > 0) {
          await session.persist().catch(() => {});
          // Same condition as SessionStart (a session that ran at least one turn), so the two stay paired.
          await permissions.runLifecycleHook("SessionEnd", session.cwd, session.id, { source: "disconnect" });
        }
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

/**
 * When a parent process owns this server (the desktop app sets FINANFA_PARENT_PID), exit once it is gone:
 * if the app crashes or is force-quit its child would otherwise keep running, with its port and its agent.
 */
function exitWhenParentIsGone(rawPid: string | undefined): void {
  const parentPid = Number(rawPid);
  if (!rawPid || !Number.isInteger(parentPid) || parentPid <= 1) return;
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      // EPERM means it exists but isn't ours to signal — still alive. Only ESRCH means gone.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") process.exit(0);
    }
  }, 2000).unref();
}
exitWhenParentIsGone(process.env.FINANFA_PARENT_PID);

httpServer.listen(PORT, BIND_HOST, () => {
  // Log the REAL bound port, not the requested one — with PORT=0 (used by
  // the e2e test suite to get a genuinely free, OS-assigned port instead
  // of guessing an unused one in a fixed range) they're different, and
  // spawn-server.ts's waitForServerReady parses this exact line to learn
  // which port the server actually ended up on.
  const boundPort = (httpServer.address() as { port: number }).port;
  console.log(`finanfa-code-web server listening on http://localhost:${boundPort} (bound to ${BIND_HOST}; default workspace: ${DEFAULT_CWD})`);

  // Real risk this is meant to surface before someone gets burned by it,
  // not just a reminder: with GATEWAY_ENABLED off, every request/connection
  // is treated as one shared, unauthenticated user — anyone who reaches this
  // server's URL can drive the agent (including bash/file-write tools) as
  // if they were sitting at the keyboard. Fine for local/loopback use (the
  // "exactly as before this feature existed" default this deliberately
  // doesn't change), genuinely dangerous the moment this process is reachable
  // from outside localhost — e.g. deployed via fly.toml/render.yaml with no
  // FINANFA_WEB_USERS/FINANFA_WEB_ACCOUNTS/OIDC configured. A warning, not a
  // hard refusal to start: this file has no other signal (no NODE_ENV check
  // elsewhere) to reliably distinguish "intentionally local-only" from
  // "about to be deployed," and failing to start at all would be a worse
  // surprise for the common local case than one loud log line.
  if (!GATEWAY_ENABLED) {
    console.warn(
      "⚠ No gateway auth configured (FINANFA_WEB_USERS / FINANFA_WEB_ACCOUNTS=1 / OIDC), every request is treated " +
        "as one shared, unauthenticated user with full agent access (including shell/file tools). Safe for local-only " +
        "use (127.0.0.1); before exposing this server publicly (a real domain, a cloud deploy, a tunnel), set one of " +
        "those up first, see README's Setup section.",
    );
    if (!ORIGIN_POLICY.loopbackBound) {
      console.warn(`⚠ ...and it is bound to ${BIND_HOST}, i.e. reachable from the network. Set FINANFA_WEB_HOST=127.0.0.1, or configure gateway auth.`);
    }
  }

  // Opt-in only (see cloudflare-tunnel.ts's own header comment) — a real
  // public HTTPS URL is what every webhook-based channel (Telegram,
  // Discord, ...) actually needs, previously only obtainable by running
  // `cloudflared` by hand in a separate terminal. Fire-and-forget: the
  // server is already usable locally regardless of whether/when this
  // resolves, and channels-config-api.ts's baseUrlFor() falls back to the
  // request's own host until it does.
  if (process.env.FINANFA_TUNNEL) {
    void startCloudflareTunnel(boundPort).then((tunnel) => {
      if (!tunnel) return;
      setPublicTunnelUrl(tunnel.url);
      // Node only exits on SIGINT/SIGTERM by default when nothing is
      // listening for it — adding this handler to stop the tunnel process
      // (so it doesn't linger as an orphan, same concern as this project's
      // other subprocess spawns) means we're now responsible for actually
      // exiting afterward too.
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
          tunnel.stop();
          process.exit(0);
        });
      }
    });
  }
});
