import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle, type VisionRoute } from "@finanfa/core/src/core/loop.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { loadHooksConfig } from "@finanfa/core/src/hooks/config.js";
import { resolveTrust } from "@finanfa/core/src/core/trust-gate.js";
import { CommandRegistry } from "@finanfa/core/src/commands/registry.js";
import { registerBuiltinCommands } from "@finanfa/core/src/commands/builtin.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import { loadPlugins } from "@finanfa/core/src/plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "@finanfa/core/src/skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "@finanfa/core/src/memory/loader.js";
import { loadSubagentTypes } from "@finanfa/core/src/agents/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import type { FinanfaConfig } from "@finanfa/core/src/core/config.js";
import type { LlmProvider, NeutralImage } from "@finanfa/core/src/core/types.js";
import { loadConfig, thinkingBudgetTokensFromConfig } from "@finanfa/core/src/core/config.js";
import { BASE_SYSTEM_PROMPT, selectProvider, selectVisionProvider, connectMcpServers } from "@finanfa/core/src/app.js";
import { detectLocalProviders } from "@finanfa/core/src/core/local-providers.js";
import { isOllamaAvailable, listOllamaModels, pullOllamaModel as pullOllamaModelCore, type OllamaPullProgress } from "@finanfa/core/src/core/ollama-models.js";
import { EFFORT_TIERS, getEffortTier, isDefaultProviderTier, MINIMAL_TOOL_SET } from "@finanfa/core/src/core/effort-tiers.js";
import { AnthropicProvider } from "@finanfa/core/src/providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "@finanfa/core/src/providers/openai-compatible-provider.js";
import { PRICING } from "@finanfa/core/src/core/pricing.js";

export type ProviderFamily = "anthropic" | "openai-compatible";

export interface ModelInfo {
  id: string;
  family: ProviderFamily;
  configured: boolean;
  /** Set for a detected local runtime (Ollama/...) — talk to this exact endpoint instead of whatever's saved in config. */
  baseUrl?: string;
  /** The real model string the provider expects — only differs from `id` for a local model, where `id` is a display label. */
  localModelId?: string;
}

export interface ModelListing {
  activeProviderKind: string;
  defaultModel?: string;
  models: ModelInfo[];
}

export interface EffortTierInfo {
  id: string;
  label: string;
  description: string;
  model: string;
  ollamaModel?: string;
  installed: boolean;
}

export type SetModelResult = { ok: true } | { ok: false; kind: "model_unavailable"; model: string; family: string; message: string };

export type SetEffortResult =
  | { ok: true }
  | { ok: false; kind: "effort_needs_download"; level: string; ollamaModel: string }
  | { ok: false; kind: "model_unavailable"; model: string; family: string; message: string }
  | { ok: false; kind: "error"; message: string };

/**
 * True for a baseUrl pointed at this machine itself (localhost/127.0.0.1/::1)
 * — a locally-run model, as opposed to a remote hosted API. Mirrors
 * packages/web-server/src/index.ts's own private helper of the same name —
 * not exported from @finanfa/core, so duplicated here rather than growing
 * web-server's public surface just for this.
 */
function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Real capability lookup against Ollama's own /api/tags — mirrors web-server's lookupOllamaToolSupport. */
async function lookupOllamaToolSupport(modelName: string): Promise<boolean | undefined> {
  try {
    const models = await listOllamaModels();
    return models.find((m) => m.name === modelName)?.supportsTools;
  } catch {
    return undefined;
  }
}

/** Mirrors web-server's familyAvailability — whether enough config/env is present to actually construct each provider family. */
async function familyAvailability(config: FinanfaConfig): Promise<Record<ProviderFamily, boolean>> {
  const savedFamily: ProviderFamily = config.provider === "openai-compatible" ? "openai-compatible" : "anthropic";
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(config.anthropicApiKey) || (savedFamily === "anthropic" && Boolean(config.apiKey)),
    "openai-compatible": Boolean(process.env.FINANFA_BASE_URL) || (savedFamily === "openai-compatible" && Boolean(config.baseUrl)),
  };
}

/** Mirrors web-server's buildProvider. */
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
  return new OpenAiCompatibleProvider({ baseUrl, apiKey });
}

/**
 * The engine wiring for the VS Code extension — same shape as
 * packages/cli/src/cli.ts's main() (loadConfig → ... → registerStatefulBuiltins),
 * reduced to the "interactive session with a UI" path (no --prompt/one-shot
 * mode, no commander/argv parsing — those are CLI-specific). See the plan's
 * §2 for the exact step-by-step correspondence.
 *
 * Deliberately yolo/non-interactive: false — a real UIAdapter.askUser is
 * always available here (the webview), so permission prompts and the trust
 * gate work exactly like the CLI's interactive REPL, never auto-approved.
 */
export interface SessionRunner {
  session: AgentSession;
  provider: LlmProvider;
  visionRoute?: VisionRoute;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  browser: BrowserManager;
  commands: CommandRegistry;
  /** Current provider family kind ("anthropic"/"openai-compatible") — mutable across the runner's lifetime via switchModel/setEffort, unlike the other fields above. */
  readonly providerKind: string;
  sendMessage(text: string, images?: NeutralImage[]): Promise<void>;
  /** Mirrors web-server's GET /api/models — same zero-config local-runtime detection, reused directly rather than re-implemented. */
  listModels(): Promise<ModelListing>;
  /** Mirrors web-server's GET /api/effort-tiers — static catalog plus each local tier's real installed/missing state. */
  listEffortTiers(): Promise<EffortTierInfo[]>;
  /** Mirrors web-server's "set_model" ws handler — switches provider/model for the next turn, persisting the choice on the session so a resume reconstructs the same endpoint. */
  switchModel(model: string, family: string, baseUrl?: string): Promise<SetModelResult>;
  /** Mirrors web-server's "set_effort" ws handler — applies a curated model/maxTokens/tool-budget tier in one call, offering to pull a missing local model instead of failing outright. */
  setEffort(level: string): Promise<SetEffortResult>;
  /** Mirrors web-server's GET /api/ollama-models/pull SSE endpoint, minus the transport (no HTTP server here) — progress is reported via the callback instead of writing SSE frames. */
  pullOllamaModel(name: string, onProgress: (completed: number | undefined, total: number | undefined) => void): Promise<void>;
  /** Persists the session and closes MCP/browser connections — call once, on extension deactivate or webview panel disposal, never awaited from a path that itself must stay responsive to shutdown. */
  dispose(): Promise<void>;
}

export interface CreateSessionRunnerOptions {
  /** Resume this specific session id instead of starting a new one. */
  resumeSessionId?: string;
  /** Explicit model override — defaults to the configured provider's own default model. */
  model?: string;
}

export async function createSessionRunner(cwd: string, ui: UIAdapter, opts: CreateSessionRunnerOptions = {}): Promise<SessionRunner> {
  const config = await loadConfig(cwd);
  const initial = selectProvider(config);
  const defaultModel = initial.defaultModel;
  // Mutable — switchModel/setEffort below can swap both to a different
  // provider family or local endpoint, same as web-server's own `provider`/
  // `providerKind` locals in handleConnection.
  let provider: LlmProvider = initial.provider;
  let providerKind: string = initial.kind;
  const model = opts.model ?? defaultModel;
  const visionRoute = selectVisionProvider(config);

  const tools = new ToolRegistry();
  registerBuiltins(tools, { sandbox: config.sandbox });

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));

  tools.register(writeMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) tools.register(createReadMemoryTool(cwd));

  const agentTypes = await loadSubagentTypes(cwd);
  const projectInstructions = await loadProjectInstructions(cwd);
  const designContract = await loadDesignContract(cwd);

  const systemPrompt =
    BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories) + formatProjectInstructions(projectInstructions);

  let session: AgentSession;
  if (opts.resumeSessionId) {
    try {
      session = await AgentSession.resume(cwd, opts.resumeSessionId, systemPrompt);
    } catch (err) {
      // Same "warn and fall back to a fresh session" policy as the CLI's
      // resolveSession — a stale/corrupted session id must not prevent the
      // panel from opening at all. ENOENT specifically means the id
      // chat-view-provider.ts remembered was never actually persisted (the
      // previous panel was closed before its first message ran a single
      // runTurn — session.persist() only happens during a turn) — an
      // expected, harmless condition on a fresh workspace, not a real
      // failure, so it stays a quiet system note rather than a red error.
      const message = err instanceof Error ? err.message : String(err);
      const isMissingFile = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
      const note = `Session "${opts.resumeSessionId}" is not available (${message}). Starting a new session instead.`;
      if (isMissingFile) ui.writeSystem(note);
      else ui.writeError(note);
      session = new AgentSession({ cwd, model, systemPrompt });
    }
  } else {
    session = new AgentSession({ cwd, model, systemPrompt });
  }
  if (session.thinkingBudgetTokens === undefined) session.thinkingBudgetTokens = thinkingBudgetTokensFromConfig(config);

  // Real reported bug: reconstructs the provider/endpoint this session
  // actually last talked to, if it ever switched away from the
  // config-derived default (see switchModel/setEffort below — the only
  // things that ever set these two fields) — mirrors web-server's own
  // handleConnection comment. Without this, resuming a session that had
  // switched to e.g. Claude kept the model NAME ("claude-opus-5") but
  // silently reverted the provider back to whatever the default is
  // (Poolside), sending a model name that provider had never heard of —
  // exactly the 404 reported against inference.poolside.ai.
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
      ui.writeError(
        `This session was last using a ${family} model, but ${family} isn't configured — falling back to the default (${providerKind}). Switch models to restore it.`,
      );
    }
  }

  const trusted = await resolveTrust(cwd, ui, false);
  const permissionConfig = await loadPermissionConfig(cwd, trusted);
  const hooksConfig = await loadHooksConfig(cwd, trusted);

  const permissions = new PermissionManager({ config: permissionConfig, ui, yolo: false, nonInteractive: false, hooksConfig });

  const mcp = new McpClientManager();
  const browser = new BrowserManager();

  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  await loadPlugins(cwd, tools, commands);

  await connectMcpServers(cwd, mcp, ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  registerStatefulBuiltins(tools, { provider, permissions, ui, model, cwd, browser, designContract: designContract.content, systemPrompt, agentTypes });

  // Warn once per runner (not once per switch) about a local model's full
  // system-prompt-plus-tool-list overhead — same real, reported crash
  // pattern web-server's own warnedAboutLocalModelThisConnection guards
  // against (see its own comment on set_model).
  let warnedAboutLocalModel = false;

  return {
    session,
    get provider() {
      return provider;
    },
    visionRoute,
    tools,
    permissions,
    mcp,
    browser,
    commands,
    get providerKind() {
      return providerKind;
    },
    async sendMessage(text, images) {
      await runTurn(session, provider, ui, tools, permissions, text, visionRoute, images);
      await maybeGenerateTitle(session, provider);
    },
    async listModels(): Promise<ModelListing> {
      const availability = await familyAvailability(config);
      const localModels = await detectLocalProviders();
      const models: ModelInfo[] = [
        ...Object.keys(PRICING).map((id) => ({ id, family: "anthropic" as const, configured: availability.anthropic })),
        ...(availability["openai-compatible"] && defaultModel && initial.kind === "openai-compatible"
          ? [{ id: defaultModel, family: "openai-compatible" as const, configured: true }]
          : []),
        ...localModels.map((m) => ({
          id: `${m.source}: ${m.id}`,
          family: "openai-compatible" as const,
          configured: true,
          baseUrl: m.baseUrl,
          localModelId: m.id,
        })),
      ];
      return { activeProviderKind: initial.kind, defaultModel, models };
    },
    async listEffortTiers(): Promise<EffortTierInfo[]> {
      const ollamaModels = (await isOllamaAvailable().catch(() => false)) ? await listOllamaModels().catch(() => []) : [];
      const installedNames = new Set(ollamaModels.map((m) => m.name));
      return EFFORT_TIERS.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        model: isDefaultProviderTier(t) ? (defaultModel ?? t.model) : t.model,
        ollamaModel: t.ollamaModel,
        installed: t.ollamaModel ? installedNames.has(t.ollamaModel) : true,
      }));
    },
    async switchModel(newModel, family, baseUrl): Promise<SetModelResult> {
      const requestedFamily: ProviderFamily = family === "openai-compatible" ? "openai-compatible" : "anthropic";
      // Same "switching away from a baseUrl override always forces a
      // rebuild, even within the same family" fix as web-server's set_model
      // — see its own comment for the real bug this closes.
      const hadBaseUrlOverride = Boolean(session.providerBaseUrl);
      if (baseUrl) {
        provider = new OpenAiCompatibleProvider({ baseUrl, apiKey: undefined });
        providerKind = "openai-compatible";
      } else if (requestedFamily !== providerKind || hadBaseUrlOverride) {
        const availability = await familyAvailability(config);
        if (!availability[requestedFamily]) {
          return {
            ok: false,
            kind: "model_unavailable",
            model: newModel,
            family: requestedFamily,
            message:
              requestedFamily === "anthropic"
                ? "Aucune clé API Anthropic configurée. Ajoutez-en une pour utiliser les modèles Claude."
                : "Aucune URL de base configurée pour un fournisseur compatible OpenAI.",
          };
        }
        provider = buildProvider(requestedFamily, config);
        providerKind = requestedFamily;
      }

      session.providerKind = providerKind;
      session.providerBaseUrl = baseUrl || undefined;
      session.model = newModel;
      const hadEffort = Boolean(session.effort);
      session.effort = undefined;

      if (baseUrl && isLocalBaseUrl(baseUrl)) {
        const supportsTools = await lookupOllamaToolSupport(newModel);
        session.disabledTools.clear();
        if (supportsTools === false) {
          for (const t of tools.list()) session.disabledTools.add(t.name);
        } else if (supportsTools === true) {
          for (const t of tools.list()) if (!MINIMAL_TOOL_SET.includes(t.name)) session.disabledTools.add(t.name);
        }
      } else if (hadEffort) {
        session.disabledTools.clear();
      }

      if (!warnedAboutLocalModel && session.providerBaseUrl && isLocalBaseUrl(session.providerBaseUrl)) {
        warnedAboutLocalModel = true;
        const enabledToolCount = tools.list().filter((t) => !session.disabledTools.has(t.name)).length;
        ui.writeSystem(
          `⚠ ${newModel} est un modèle local — chaque message envoyé ici inclut l'intégralité du prompt système et de la liste ` +
            `d'outils de cet agent (actuellement ${enabledToolCount} outils, des dizaines de milliers de tokens à eux seuls, avant ` +
            "même la conversation). Sur une machine à mémoire limitée ou sans GPU, un runtime local qui tente d'allouer assez de " +
            "contexte pour cela peut saturer la mémoire au point de figer ou planter tout le système, pas seulement échouer " +
            "proprement. Si cela arrive, désactivez la plupart des outils avant de réessayer un modèle local.",
        );
      }

      return { ok: true };
    },
    async setEffort(level): Promise<SetEffortResult> {
      const tier = getEffortTier(level);
      if (!tier) return { ok: false, kind: "error", message: `Niveau d'effort inconnu : ${level}` };

      if (tier.ollamaModel) {
        const available = await isOllamaAvailable().catch(() => false);
        const installed = available && (await listOllamaModels().catch(() => [])).some((m) => m.name === tier.ollamaModel);
        if (!installed) return { ok: false, kind: "effort_needs_download", level: tier.id, ollamaModel: tier.ollamaModel };
      }

      let resolvedModel = tier.model;
      let resolvedFamily = tier.family;
      if (isDefaultProviderTier(tier)) {
        try {
          const selected = selectProvider(config);
          resolvedModel = selected.defaultModel;
          resolvedFamily = selected.kind === "openai-compatible" ? "openai-compatible" : "anthropic";
        } catch {
          return {
            ok: false,
            kind: "model_unavailable",
            model: tier.model,
            family: "anthropic",
            message: "Aucun fournisseur par défaut configuré pour ce projet.",
          };
        }
      }

      if (tier.baseUrl) {
        provider = new OpenAiCompatibleProvider({ baseUrl: tier.baseUrl, apiKey: undefined });
        providerKind = "openai-compatible";
      } else if (resolvedFamily) {
        const availability = await familyAvailability(config);
        if (!availability[resolvedFamily]) {
          return {
            ok: false,
            kind: "model_unavailable",
            model: resolvedModel,
            family: resolvedFamily,
            message:
              resolvedFamily === "anthropic" ? "Aucune clé API Anthropic configurée." : "Aucune URL de base configurée pour ce fournisseur.",
          };
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

      return { ok: true };
    },
    async pullOllamaModel(name, onProgress): Promise<void> {
      await pullOllamaModelCore(name, (p: OllamaPullProgress) => onProgress(p.completed, p.total));
    },
    async dispose() {
      for (const controller of session.activeAbortControllers) controller.abort();
      await session.persist().catch(() => {});
      await mcp.disconnectAll().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
