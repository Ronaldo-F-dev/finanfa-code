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
import type { LlmProvider, NeutralImage } from "@finanfa/core/src/core/types.js";
import { loadConfig } from "@finanfa/core/src/core/config.js";
import { BASE_SYSTEM_PROMPT, selectProvider, selectVisionProvider, connectMcpServers } from "@finanfa/core/src/app.js";

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
  providerKind: string;
  sendMessage(text: string, images?: NeutralImage[]): Promise<void>;
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
  const { provider, defaultModel, kind: providerKind } = selectProvider(config);
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
      // panel from opening at all.
      ui.writeError(
        `Could not resume session "${opts.resumeSessionId}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
      );
      session = new AgentSession({ cwd, model, systemPrompt });
    }
  } else {
    session = new AgentSession({ cwd, model, systemPrompt });
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

  return {
    session,
    provider,
    visionRoute,
    tools,
    permissions,
    mcp,
    browser,
    commands,
    providerKind,
    async sendMessage(text, images) {
      await runTurn(session, provider, ui, tools, permissions, text, visionRoute, images);
      await maybeGenerateTitle(session, provider);
    },
    async dispose() {
      for (const controller of session.activeAbortControllers) controller.abort();
      await session.persist().catch(() => {});
      await mcp.disconnectAll().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
