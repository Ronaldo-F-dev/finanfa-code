import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle } from "@finanfa/core/src/core/loop.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { loadHooksConfig } from "@finanfa/core/src/hooks/config.js";
import { resolveTrust } from "@finanfa/core/src/core/trust-gate.js";
import { CommandRegistry } from "@finanfa/core/src/commands/registry.js";
import { loadPlugins } from "@finanfa/core/src/plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "@finanfa/core/src/skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "@finanfa/core/src/memory/loader.js";
import { loadSubagentTypes } from "@finanfa/core/src/agents/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadScopedInstructions, formatScopedInstructions } from "@finanfa/core/src/core/scoped-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig, thinkingBudgetTokensFromConfig } from "@finanfa/core/src/core/config.js";
import { BASE_SYSTEM_PROMPT, selectProvider } from "@finanfa/core/src/app.js";
import type { LlmProvider } from "@finanfa/core/src/core/types.js";
import type { UIAdapter, ToolCallAnnouncement, ToolResultAnnouncement } from "@finanfa/core/src/ui/adapter.js";

// finanfa-code as an ACP *agent*: an ACP client (Zed, or another
// ACP-aware editor) connects over stdio and drives real turns against
// this project's own agent loop — the same tools/permissions/hooks a
// terminal session would use, no separate "Gateway" process. Deliberately
// scoped to the protocol's core lifecycle (initialize, session/new,
// session/prompt with streamed text + tool_call/tool_call_update,
// session/request_permission, session/cancel) — richer surfaces (session
// modes, per-session MCP servers, client filesystem/terminal methods,
// loadSession replay) are out of scope for this first pass, same as most
// ACP-native agents only cover a subset in practice.

interface AcpSessionState {
  cwd: string;
  session: AgentSession;
  provider: LlmProvider;
  tools: ToolRegistry;
  permissions: PermissionManager;
  systemPrompt: string;
  browser: BrowserManager;
  ui: UIAdapter;
  /** Set by the session/cancel notification handler, read right after runTurn resolves — runTurn itself never throws or otherwise signals cancellation to its caller on an abort (see loop.ts: it catches AbortError internally, writes "Interrupted." via the ui, and returns normally), so this is the only way session/prompt's response can report stopReason "cancelled" instead of "end_turn". */
  cancelRequested: boolean;
}

const TOOL_KIND_BY_PREFIX: [prefix: string, kind: acp.ToolKind][] = [
  ["read_", "read"],
  ["write_", "edit"],
  ["edit_", "edit"],
  ["multi_edit_", "edit"],
  ["glob", "search"],
  ["grep", "search"],
  ["web_search", "search"],
  ["web_fetch", "fetch"],
  ["http_request", "fetch"],
  ["bash", "execute"],
  ["run_", "execute"],
  ["git_", "execute"],
];

function toolKindFor(toolName: string): acp.ToolKind {
  const hit = TOOL_KIND_BY_PREFIX.find(([prefix]) => toolName.startsWith(prefix));
  return hit ? hit[1] : "other";
}

/** Extracts a tool name from PermissionManager's plain natural-language prompt string (`wants to run "X": ...`) — the cleanest option available for display purposes (title/kind), since askUser's real correlation with the tool_call/tool_call_update trio comes from its toolCallId param instead (see askUser below), not from re-deriving the ToolDefinition here. */
function toolNameFromPrompt(prompt: string): string {
  return /wants to run "([^"]+)"/.exec(prompt)?.[1] ?? "tool";
}

/**
 * Builds the UIAdapter that bridges finanfa-code's agent loop to one ACP
 * session's notifications/requests. `notify`/`request` are bound to this
 * exact session's connection context (passed in by whichever handler is
 * currently running — initialize/prompt/etc. each get their own `cx` from
 * the SDK, but they all talk to the same underlying connection).
 */
function createAcpUiAdapter(sessionId: string, cx: { notify: typeof acp.AgentSideConnection.prototype.notify; request: typeof acp.AgentSideConnection.prototype.request }): UIAdapter {
  function update(sessionUpdate: acp.SessionUpdate): Promise<void> {
    return cx.notify(acp.methods.client.session.update, { sessionId, update: sessionUpdate });
  }

  return {
    writeAssistantDelta(text) {
      void update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    },
    endAssistantMessage() {},
    writeBanner() {},
    writeSystem(text) {
      void update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${text}\n` } });
    },
    writeError(text) {
      void update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\nError: ${text}\n` } });
    },
    writeToolCall(info: ToolCallAnnouncement) {
      void update({
        sessionUpdate: "tool_call",
        toolCallId: info.toolCallId,
        title: info.description || info.toolName,
        kind: toolKindFor(info.toolName),
        status: "pending",
      });
    },
    writeToolResult(info: ToolResultAnnouncement) {
      void update({
        sessionUpdate: "tool_call_update",
        toolCallId: info.toolCallId,
        status: info.isError ? "failed" : "completed",
        content: info.content.trim() ? [{ type: "content", content: { type: "text", text: info.content } }] : undefined,
      });
    },
    setStatus() {},
    getStatus: () => undefined,
    setCommands() {},
    setBusy() {},
    async askUser(prompt: string, kind?: "input" | "confirm", toolCallId?: string) {
      if (kind !== "confirm") return ""; // ACP prompts arrive as full turns, not mid-turn plain-text asks
      // toolCallId is the real call.id PermissionManager.check received from
      // the agent loop (see loop.ts) — the same id the writeToolCall a
      // moment later will announce for this exact call, so an ACP client
      // can correlate this permission request with that tool_call. Only
      // falls back to a synthetic id for an ask with no backing tool call
      // at all (there is currently none on this path, but askUser's own
      // signature allows it).
      const toolName = toolNameFromPrompt(prompt);
      const response = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: toolCallId ?? `permission-${Date.now()}`, title: prompt, kind: toolKindFor(toolName) },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "y" },
          { kind: "reject_once", name: "Deny", optionId: "n" },
          { kind: "allow_always", name: `Always allow this exact action this session`, optionId: "a" },
          { kind: "allow_always", name: `Always allow "${toolName}" this session`, optionId: "t" },
        ],
      });
      if (response.outcome.outcome === "cancelled") return "n";
      return response.outcome.optionId;
    },
    close() {},
  };
}

async function createAcpSession(cwd: string, cx: { notify: typeof acp.AgentSideConnection.prototype.notify; request: typeof acp.AgentSideConnection.prototype.request }): Promise<AcpSessionState> {
  const config = await loadConfig(cwd);
  const { provider, defaultModel } = selectProvider(config);

  const tools = new ToolRegistry();
  registerBuiltins(tools, { sandbox: config.sandbox });

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));
  tools.register(writeMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) tools.register(createReadMemoryTool(cwd));

  const projectInstructions = await loadProjectInstructions(cwd);
  const scopedInstructions = await loadScopedInstructions(cwd);
  const designContract = await loadDesignContract(cwd);
  const systemPrompt =
    BASE_SYSTEM_PROMPT +
    formatSkillIndex(skills) +
    formatMemoryIndex(memories) +
    formatProjectInstructions(projectInstructions) +
    formatScopedInstructions(scopedInstructions);

  const session = new AgentSession({ cwd, model: defaultModel, systemPrompt });
  session.thinkingBudgetTokens = thinkingBudgetTokensFromConfig(config);
  const ui = createAcpUiAdapter(session.id, cx);

  // Same folder-trust gate every other entry point applies (CLI, web
  // server, headless channels) — an editor pointed at an untrusted
  // project must not silently run its hooks/plugins either. There's no
  // human to answer an interactive prompt over ACP today, so this fails
  // closed exactly like a non-interactive run — resolveTrust never
  // actually calls ui.askUser when nonInteractive is true.
  const trusted = await resolveTrust(cwd, ui, true);
  const permissionConfig = await loadPermissionConfig(cwd, trusted);
  const hooksConfig = await loadHooksConfig(cwd, trusted);
  if (trusted) await loadPlugins(cwd, tools, new CommandRegistry());
  const permissions = new PermissionManager({ config: permissionConfig, ui, hooksConfig });

  const browser = new BrowserManager();
  const agentTypes = await loadSubagentTypes(cwd);
  registerStatefulBuiltins(tools, { provider, permissions, ui, model: session.model, cwd, browser, designContract: designContract.content, systemPrompt, agentTypes });

  return { cwd, session, provider, tools, permissions, systemPrompt, browser, ui, cancelRequested: false };
}

export async function runAcpAgent(cwd: string): Promise<void> {
  const sessions = new Map<string, AcpSessionState>();

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);

  await acp
    .agent({ name: "finanfa-code" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest(acp.methods.agent.authenticate, async () => ({}))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const state = await createAcpSession(ctx.params.cwd || cwd, ctx.client);
      sessions.set(state.session.id, state);
      return { sessionId: state.session.id };
    })
    .onRequest(acp.methods.agent.session.setMode, async () => ({}))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const state = sessions.get(ctx.params.sessionId);
      if (!state) throw new Error(`Unknown session ${ctx.params.sessionId}`);

      const text = ctx.params.prompt
        .filter((block): block is acp.ContentBlock & { type: "text" } => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      state.cancelRequested = false;
      await runTurn(state.session, state.provider, state.ui, state.tools, state.permissions, text);
      await maybeGenerateTitle(state.session, state.provider);
      await state.session.persist();
      return { stopReason: state.cancelRequested ? "cancelled" : "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      const state = sessions.get(ctx.params.sessionId);
      if (!state) return;
      state.cancelRequested = true;
      for (const controller of state.session.activeAbortControllers) controller.abort();
    })
    .connect(stream);
}
