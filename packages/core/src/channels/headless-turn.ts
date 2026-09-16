import { AgentSession } from "../core/session.js";
import { runTurn, maybeGenerateTitle } from "../core/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "../tools/builtin/index.js";
import { PermissionManager } from "../permissions/manager.js";
import { loadPermissionConfig } from "../permissions/config.js";
import { loadHooksConfig } from "../hooks/config.js";
import { resolveTrust } from "../core/trust-gate.js";
import { CommandRegistry } from "../commands/registry.js";
import { loadPlugins } from "../plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "../skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "../memory/loader.js";
import { loadSubagentTypes } from "../agents/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "../core/project-instructions.js";
import { loadDesignContract } from "../core/design-contract.js";
import { BrowserManager } from "../browser/manager.js";
import { loadConfig } from "../core/config.js";
import { BASE_SYSTEM_PROMPT, selectProvider } from "../app.js";
import type { UIAdapter } from "../ui/adapter.js";

/**
 * Buffers the assistant's reply instead of rendering it anywhere — an
 * inbound channel message (see slack.ts) has no terminal/browser to
 * stream into, just one final reply to post back. askUser resolves
 * immediately since there's no human here to answer a prompt anyway
 * (PermissionManager's own nonInteractive mode never actually calls it —
 * see runHeadlessTurn below — but a plugin or hook conceivably could).
 */
function createBufferingUiAdapter(): UIAdapter & { replyText: () => string } {
  let buffer = "";
  return {
    writeAssistantDelta(text) {
      buffer += text;
    },
    endAssistantMessage() {},
    writeBanner() {},
    writeSystem() {},
    writeError() {},
    writeToolCall() {},
    setStatus() {},
    getStatus: () => undefined,
    setCommands() {},
    setBusy() {},
    async askUser() {
      return "";
    },
    close() {},
    replyText: () => buffer,
  };
}

export interface HeadlessTurnResult {
  replyText: string;
}

/**
 * Runs exactly one full agent turn for an inbound channel message (Slack
 * today; the same shape any future channel — Telegram, Discord, ... —
 * would reuse) and returns the assistant's final reply text. Mirrors the
 * CLI's --prompt one-shot mode (cli.ts) and the VS Code extension's
 * session-runner.ts: same core wiring, no interactive UI to drive.
 *
 * `sessionId` is the caller's own stable key for "this conversation" (see
 * slack.ts's channel+thread keying) — resumed if it already exists,
 * created fresh otherwise, so context carries across messages in the same
 * thread the same way a terminal session persists across turns.
 */
export async function runHeadlessTurn(cwd: string, sessionId: string, userText: string): Promise<HeadlessTurnResult> {
  const ui = createBufferingUiAdapter();
  const config = await loadConfig(cwd);
  const { provider, defaultModel } = selectProvider(config);

  const tools = new ToolRegistry();
  registerBuiltins(tools, { sandbox: config.sandbox });

  // No human is present to answer a folder-trust prompt for an inbound
  // channel message, so this fails closed exactly like a non-interactive
  // CLI run: an untrusted project's hooks/plugins are simply skipped
  // rather than ever silently auto-approved.
  const trusted = await resolveTrust(cwd, ui, true);
  const permissionConfig = await loadPermissionConfig(cwd, trusted);
  const hooksConfig = await loadHooksConfig(cwd, trusted);
  const permissions = new PermissionManager({ config: permissionConfig, ui, nonInteractive: true, hooksConfig });
  if (trusted) await loadPlugins(cwd, tools, new CommandRegistry());

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));
  tools.register(writeMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) tools.register(createReadMemoryTool(cwd));

  const projectInstructions = await loadProjectInstructions(cwd);
  const designContract = await loadDesignContract(cwd);
  const systemPrompt =
    BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories) + formatProjectInstructions(projectInstructions);

  let session: AgentSession;
  try {
    session = await AgentSession.resume(cwd, sessionId, systemPrompt);
  } catch {
    session = new AgentSession({ id: sessionId, cwd, model: defaultModel, systemPrompt });
  }

  const browser = new BrowserManager();
  try {
    const agentTypes = await loadSubagentTypes(cwd);
    registerStatefulBuiltins(tools, {
      provider,
      permissions,
      ui,
      model: session.model,
      cwd,
      browser,
      designContract: designContract.content,
      systemPrompt,
      agentTypes,
    });

    await runTurn(session, provider, ui, tools, permissions, userText);
    await maybeGenerateTitle(session, provider);
    await session.persist();
  } finally {
    await browser.close();
  }

  return { replyText: ui.replyText() };
}
