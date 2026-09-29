import { randomUUID } from "node:crypto";
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
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool, deleteMemoryTool, findDuplicateMemoriesTool, createSearchMemoriesTool } from "@finanfa/core/src/memory/loader.js";
import { embeddingsConfigFromEnv } from "@finanfa/core/src/core/embeddings.js";
import { loadSubagentTypes } from "@finanfa/core/src/agents/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadScopedInstructions, formatScopedInstructions } from "@finanfa/core/src/core/scoped-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig, thinkingBudgetTokensFromConfig, resolveToolSearchEnabled, resolveLocalModelLeanEnabled } from "@finanfa/core/src/core/config.js";
import { baseSystemPromptFor, selectProvider, isLocalProviderConfig, connectMcpServers } from "@finanfa/core/src/app.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import type { McpServerConfig } from "@finanfa/core/src/mcp/config.js";
import type { LlmProvider } from "@finanfa/core/src/core/types.js";
import type { UIAdapter, ToolCallAnnouncement, ToolResultAnnouncement } from "@finanfa/core/src/ui/adapter.js";
import { createAcpReadFileTool, createAcpWriteFileTool, createAcpBashTool } from "./acp-client-tools.js";

// finanfa-code as an ACP *agent*: an ACP client (Zed, or another
// ACP-aware editor) connects over stdio and drives real turns against
// this project's own agent loop — the same tools/permissions/hooks a
// terminal session would use, no separate "Gateway" process. Covers the
// protocol's core lifecycle (initialize, session/new, session/prompt with
// streamed text + tool_call/tool_call_update, session/request_permission,
// session/cancel) plus session modes (session/set_mode, mapped onto plan
// mode), per-session MCP servers (session/new|load's mcpServers, connected
// alongside this project's own .finanfa-code/mcp.json), client-routed
// filesystem/terminal tools (read_file/write_file/bash go through the
// client's fs/terminal RPCs instead of this process's own filesystem when
// the client actually advertises support for them at initialize), and
// session/load replay from this project's own persisted AgentSession
// history. Extension methods this SDK also exposes (providers/*, nes/*,
// document/*, session/fork, session/list, session/resume, session/close,
// config options) still aren't implemented — no client this project has
// been driven by negotiates them yet.

interface AcpSessionState {
  cwd: string;
  session: AgentSession;
  provider: LlmProvider;
  tools: ToolRegistry;
  permissions: PermissionManager;
  systemPrompt: string;
  browser: BrowserManager;
  ui: UIAdapter;
  /** Kept alive for the life of the session so its connections (stdio child processes, HTTP/SSE clients) aren't only reachable through transport-internal listeners — see createAcpSession's own doc comment on why per-session MCP servers get their own manager instead of sharing one across sessions. */
  mcp: McpClientManager;
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

// --- Session modes ---------------------------------------------------
// finanfa-code's own /plan slash command (see commands/builtin.ts) already
// maps to a single boolean, session.planMode — exposed here as ACP's
// two-mode session/set_mode surface instead of inventing separate
// ACP-only state. "plan" turning back off can also happen from the
// AGENT's side (the model calling exit_plan_mode after its plan is
// approved — see loop.ts), not just via an explicit session/set_mode
// request, hence the current_mode_update notification after every prompt
// turn that changed it (see modeIdFor's call sites in session/prompt).

const ACP_MODES: acp.SessionMode[] = [
  { id: "default", name: "Default", description: "Ordinary operation — tool calls run under the usual permission rules." },
  { id: "plan", name: "Plan", description: "Research only: every tool call except read-only ones and exit_plan_mode is auto-denied until a plan is presented and approved." },
];

function modeIdFor(session: AgentSession): acp.SessionModeId {
  return session.planMode ? "plan" : "default";
}

function sessionModeState(session: AgentSession): acp.SessionModeState {
  return { currentModeId: modeIdFor(session), availableModes: ACP_MODES };
}

type ClientRequester = { notify: typeof acp.AgentSideConnection.prototype.notify; request: typeof acp.AgentSideConnection.prototype.request };

function sendSessionUpdate(cx: ClientRequester, sessionId: string, update: acp.SessionUpdate): Promise<void> {
  return cx.notify(acp.methods.client.session.update, { sessionId, update });
}

function notifyCurrentMode(cx: ClientRequester, sessionId: string, session: AgentSession): Promise<void> {
  return sendSessionUpdate(cx, sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeIdFor(session) });
}

// --- Per-session MCP servers -------------------------------------------

/**
 * Converts one client-supplied `session/new`/`session/load` MCP server entry
 * into finanfa-code's own McpServerConfig shape, or undefined for a
 * transport McpClientManager has no equivalent for. "acp"-transport MCP
 * servers connect over this same JSON-RPC channel via mcp/connect —
 * McpClientManager only ever dials out over stdio/http/sse, so there's no
 * way to honor that one here.
 */
function acpMcpServerToConfig(server: acp.McpServer): McpServerConfig | undefined {
  if ("type" in server && server.type !== undefined) {
    if (server.type === "http") return { name: server.name, transport: "http", url: server.url };
    if (server.type === "sse") return { name: server.name, transport: "sse", url: server.url };
    return undefined;
  }
  return { name: server.name, transport: "stdio", command: server.command, args: server.args };
}

/** Connects every client-supplied MCP server (from session/new|load) on top of this project's own .finanfa-code/mcp.json — additive, not a replacement, since the client has no way to know about (or override) the project's own config, and the project's config has no way to know about a specific editor session's own servers. A name collision is resolved in the client-supplied server's favor (connected second, so it's the one left in McpClientManager's name-keyed map). */
async function connectSessionMcpServers(cwd: string, mcp: McpClientManager, ui: UIAdapter, clientServers: acp.McpServer[]): Promise<void> {
  await connectMcpServers(cwd, mcp, ui);
  for (const server of clientServers) {
    const cfg = acpMcpServerToConfig(server);
    if (!cfg) {
      ui.writeError(`MCP server "${server.name}": ACP-transport MCP servers aren't supported yet, skipping.`);
      continue;
    }
    try {
      await mcp.connect(cfg, { allowOAuthPrompt: false });
    } catch (err) {
      ui.writeError(`Failed to connect MCP server "${server.name}" supplied by the ACP client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// --- Session history replay (session/load) ------------------------------

/** Replays a resumed AgentSession's persisted history as session/update notifications, so an ACP client's UI can redisplay a prior conversation exactly the way it would have looked live — same event shapes createAcpUiAdapter emits during an actual turn, just all at once instead of streamed. */
async function replaySessionHistory(session: AgentSession, cx: ClientRequester, sessionId: string): Promise<void> {
  for (const message of session.messages) {
    if (message.role === "user") {
      if (message.content) await sendSessionUpdate(cx, sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } });
    } else if (message.role === "assistant") {
      if (message.content) await sendSessionUpdate(cx, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.content } });
      for (const call of message.toolCalls ?? []) {
        await sendSessionUpdate(cx, sessionId, { sessionUpdate: "tool_call", toolCallId: call.id, title: call.name, kind: toolKindFor(call.name), status: "pending" });
      }
    } else {
      for (const result of message.results) {
        await sendSessionUpdate(cx, sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: result.toolCallId,
          status: result.isError ? "failed" : "completed",
          content: result.content.trim() ? [{ type: "content", content: { type: "text", text: result.content } }] : undefined,
        });
      }
    }
  }
}

/**
 * Builds the UIAdapter that bridges finanfa-code's agent loop to one ACP
 * session's notifications/requests. `notify`/`request` are bound to this
 * exact session's connection context (passed in by whichever handler is
 * currently running — initialize/prompt/etc. each get their own `cx` from
 * the SDK, but they all talk to the same underlying connection).
 */
function createAcpUiAdapter(sessionId: string, cx: ClientRequester): UIAdapter {
  function update(sessionUpdate: acp.SessionUpdate): Promise<void> {
    return sendSessionUpdate(cx, sessionId, sessionUpdate);
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

interface CreateAcpSessionOptions {
  /** Set when this is session/load resuming a persisted session rather than session/new starting a fresh one — the id to resume, reused as both the AgentSession's own id and the ACP sessionId. */
  resumeSessionId?: string;
  /** MCP servers the ACP client supplied via session/new|load's own mcpServers field, connected alongside this project's own .finanfa-code/mcp.json (see connectSessionMcpServers). */
  mcpServers: acp.McpServer[];
  /** Negotiated at initialize (see runAcpAgent) — read_file/write_file/bash only get routed through the client's fs/terminal RPCs when it actually advertised support for them; otherwise they keep touching this process's own filesystem/subprocesses exactly as a terminal session would. */
  clientCapabilities: acp.ClientCapabilities;
}

async function createAcpSession(cwd: string, cx: ClientRequester, opts: CreateAcpSessionOptions): Promise<AcpSessionState> {
  const config = await loadConfig(cwd);
  const { provider, defaultModel } = selectProvider(config);

  // Resolved up front (not left to AgentSession's own default) so the tools
  // built below that need to address this exact session in client RPCs
  // (fs/read_text_file, terminal/create, ...) can be wired before the
  // AgentSession itself exists — resume's id has to be reused verbatim
  // (it's what the client keeps calling this session), a fresh session's id
  // just needs to be decided before AgentSession's own constructor does it.
  const sessionId = opts.resumeSessionId ?? randomUUID();

  const tools = new ToolRegistry();
  registerBuiltins(tools, { sandbox: config.sandbox });
  if (opts.clientCapabilities.fs?.readTextFile) tools.replace(createAcpReadFileTool(cx, sessionId));
  if (opts.clientCapabilities.fs?.writeTextFile) tools.replace(createAcpWriteFileTool(cx, sessionId, Boolean(opts.clientCapabilities.fs?.readTextFile)));
  if (opts.clientCapabilities.terminal) tools.replace(createAcpBashTool(cx, sessionId, config.sandbox));

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));
  tools.register(writeMemoryTool);
  tools.register(deleteMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) {
    tools.register(createReadMemoryTool(cwd));
    tools.register(findDuplicateMemoriesTool);
    tools.register(createSearchMemoriesTool(embeddingsConfigFromEnv()));
  }

  const projectInstructions = await loadProjectInstructions(cwd);
  const scopedInstructions = await loadScopedInstructions(cwd);
  const designContract = await loadDesignContract(cwd);
  const localModelLeanEnabled = resolveLocalModelLeanEnabled(config, isLocalProviderConfig(config));
  const systemPrompt =
    baseSystemPromptFor(localModelLeanEnabled) +
    formatSkillIndex(skills) +
    formatMemoryIndex(memories) +
    formatProjectInstructions(projectInstructions) +
    formatScopedInstructions(scopedInstructions);

  const session = opts.resumeSessionId
    ? await AgentSession.resume(cwd, opts.resumeSessionId, systemPrompt)
    : new AgentSession({ id: sessionId, cwd, model: defaultModel, systemPrompt });
  session.thinkingBudgetTokens ??= thinkingBudgetTokensFromConfig(config);
  session.toolSearchEnabled = resolveToolSearchEnabled(config, isLocalProviderConfig(config));
  session.localModelLeanEnabled = localModelLeanEnabled;
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
  const permissions = new PermissionManager({ config: permissionConfig, ui, hooksConfig, provider });

  // Own McpClientManager per ACP session (not shared/module-global) since
  // different editor sessions/projects can each supply their own servers
  // via session/new|load — see connectSessionMcpServers.
  const mcp = new McpClientManager();
  await connectSessionMcpServers(cwd, mcp, ui, opts.mcpServers);
  for (const def of await mcp.listAllTools()) tools.register(def);

  const browser = new BrowserManager();
  const agentTypes = await loadSubagentTypes(cwd);
  registerStatefulBuiltins(tools, { provider, permissions, ui, model: session.model, cwd, browser, designContract: designContract.content, systemPrompt, agentTypes });

  return { cwd, session, provider, tools, permissions, systemPrompt, browser, ui, mcp, cancelRequested: false };
}

export async function runAcpAgent(cwd: string): Promise<void> {
  const sessions = new Map<string, AcpSessionState>();
  // Populated by the single initialize call this stdio connection ever
  // makes (one process per ACP client connection) — read later by every
  // session/new|load to decide whether read_file/write_file/bash should be
  // routed through the client's own fs/terminal RPCs instead of touching
  // this process's filesystem/subprocesses directly.
  let clientCapabilities: acp.ClientCapabilities = {};

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);

  await acp
    .agent({ name: "finanfa-code" })
    .onRequest(acp.methods.agent.initialize, async (ctx) => {
      clientCapabilities = ctx.params.clientCapabilities ?? {};
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: true },
        },
      };
    })
    .onRequest(acp.methods.agent.authenticate, async () => ({}))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const state = await createAcpSession(ctx.params.cwd || cwd, ctx.client, { mcpServers: ctx.params.mcpServers, clientCapabilities });
      sessions.set(state.session.id, state);
      return { sessionId: state.session.id, modes: sessionModeState(state.session) };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const state = await createAcpSession(ctx.params.cwd || cwd, ctx.client, {
        resumeSessionId: ctx.params.sessionId,
        mcpServers: ctx.params.mcpServers,
        clientCapabilities,
      });
      sessions.set(state.session.id, state);
      await replaySessionHistory(state.session, ctx.client, state.session.id);
      return { modes: sessionModeState(state.session) };
    })
    .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
      const state = sessions.get(ctx.params.sessionId);
      if (!state) throw new Error(`Unknown session ${ctx.params.sessionId}`);
      state.session.planMode = ctx.params.modeId === "plan";
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const state = sessions.get(ctx.params.sessionId);
      if (!state) throw new Error(`Unknown session ${ctx.params.sessionId}`);

      const text = ctx.params.prompt
        .filter((block): block is acp.ContentBlock & { type: "text" } => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      state.cancelRequested = false;
      const modeBefore = modeIdFor(state.session);
      await runTurn(state.session, state.provider, state.ui, state.tools, state.permissions, text);
      // Not awaited — same real reported bug as cli.ts's repl(): this is a
      // second, separate provider call the client (IDE) has no visibility
      // into at all, and awaiting it here held the whole ACP RPC response
      // (and with it, the IDE's "still generating" state) hostage to
      // however long that invisible extra call took against a slow model.
      // Best-effort and self-persisting on success — see its own docstring.
      void maybeGenerateTitle(state.session, state.provider);
      await state.session.persist();
      // A tool call inside this turn (exit_plan_mode) can flip planMode off
      // on the agent's own initiative, not just an explicit session/set_mode
      // request from the client — tell it either way so its mode UI stays
      // in sync.
      if (modeIdFor(state.session) !== modeBefore) await notifyCurrentMode(ctx.client, ctx.params.sessionId, state.session);
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
