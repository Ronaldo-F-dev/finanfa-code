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
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool, deleteMemoryTool, findDuplicateMemoriesTool, createSearchMemoriesTool } from "../memory/loader.js";
import { embeddingsConfigFromEnv } from "../core/embeddings.js";
import { loadSubagentTypes } from "../agents/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "../core/project-instructions.js";
import { loadScopedInstructions, formatScopedInstructions } from "../core/scoped-instructions.js";
import { loadDesignContract } from "../core/design-contract.js";
import { BrowserManager } from "../browser/manager.js";
import { loadConfig, thinkingBudgetTokensFromConfig, resolveToolSearchEnabled, resolveLocalModelLeanEnabled } from "../core/config.js";
import { BASE_SYSTEM_PROMPT, selectProvider, selectVisionProvider, isLocalProviderConfig } from "../app.js";
import { waitForRemoteConfirmation } from "./pending-confirmations.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { NeutralImage } from "../core/types.js";

/**
 * Buffers the assistant's reply instead of rendering it anywhere — an
 * inbound channel message (see slack.ts) has no terminal/browser to
 * stream into, just one final reply to post back. askUser resolves
 * immediately since there's no human here to answer a prompt anyway
 * (PermissionManager's own nonInteractive mode never actually calls it —
 * see runHeadlessTurn below — but a plugin or hook conceivably could).
 *
 * Real, reported bug: writeSystem/writeError used to be no-ops here, so
 * every one of runTurn's own error branches (model-not-found, context
 * length, tools-unsupported, the fake-tool-call warning, ...) vanished
 * silently instead of reaching the channel — runTurn catches its own
 * failures internally and returns normally, so runHeadlessTurn never
 * threw either, and the caller's own replyText.trim() === "" check (see
 * e.g. channels-telegram.ts) meant no reply was posted at all. A user
 * messaging the bot with a misconfigured model got total silence,
 * indistinguishable from the bot being down. Appending them to the same
 * buffer as real assistant text means a channel user always sees
 * something instead of nothing.
 */
/**
 * `sendMessage`, when given, is what makes a real confirmation loop
 * possible at all: a channel that can post an out-of-band message mid-turn
 * (see channels-telegram.ts) and correlate the user's next inbound message
 * as the answer (pending-confirmations.ts) can let askUser actually ask,
 * instead of PermissionManager's nonInteractive mode auto-denying every
 * "ask"-risk tool call outright. Without it (a channel that hasn't wired
 * this up yet), behavior is unchanged from before: askUser is never
 * reached at all, since runHeadlessTurn passes nonInteractive: true in
 * that case.
 */
function createBufferingUiAdapter(sessionId: string, sendMessage?: (text: string) => Promise<void>): UIAdapter & { replyText: () => string } {
  let buffer = "";
  const appendLine = (text: string): void => {
    if (buffer.length > 0) buffer += "\n\n";
    buffer += text;
  };
  // With real-time delivery available, a system/error message (a failed
  // turn, an "unrecognized answer, try again" reprompt) goes out live
  // instead of waiting to be bundled into the final reply — the whole
  // point for the reprompt case, since the user needs to see it before
  // their very next message is expected to be the actual answer.
  const deliver = sendMessage ? (text: string) => void sendMessage(text) : appendLine;
  return {
    writeAssistantDelta(text) {
      buffer += text;
    },
    endAssistantMessage() {},
    writeBanner() {},
    writeSystem: deliver,
    writeError: deliver,
    writeToolCall() {},
    setStatus() {},
    getStatus: () => undefined,
    setCommands() {},
    setBusy() {},
    async askUser(prompt: string) {
      if (!sendMessage) return "";
      await sendMessage(prompt);
      return waitForRemoteConfirmation(sessionId);
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
 *
 * `images` mirrors the CLI/web/VS Code entry points' own image handling
 * (an inbound channel attachment — see channels-slack.ts — decoded to the
 * same NeutralImage shape): routed through the project's configured
 * vision fallback provider (selectVisionProvider), same as every other
 * front-end, so a primary model with no vision support still works for a
 * channel message that includes one.
 *
 * `sendMessage`, when given, is a way for this turn to post a real
 * out-of-band message back through the same channel *before* it finishes
 * (a permission-confirmation prompt for a risky tool call — see
 * createBufferingUiAdapter and pending-confirmations.ts). A channel that
 * hasn't wired this up (or a genuinely unattended one, like a scheduled
 * task with nobody to ask) keeps the previous, safer default: every
 * "ask"-risk tool call is auto-denied rather than left hanging forever
 * waiting for a reply nobody can give.
 */
export async function runHeadlessTurn(
  cwd: string,
  sessionId: string,
  userText: string,
  images?: NeutralImage[],
  sendMessage?: (text: string) => Promise<void>,
): Promise<HeadlessTurnResult> {
  const ui = createBufferingUiAdapter(sessionId, sendMessage);
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
  const permissions = new PermissionManager({ config: permissionConfig, ui, nonInteractive: !sendMessage, hooksConfig });
  if (trusted) await loadPlugins(cwd, tools, new CommandRegistry());

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
  const systemPrompt =
    BASE_SYSTEM_PROMPT +
    formatSkillIndex(skills) +
    formatMemoryIndex(memories) +
    formatProjectInstructions(projectInstructions) +
    formatScopedInstructions(scopedInstructions);

  let session: AgentSession;
  try {
    session = await AgentSession.resume(cwd, sessionId, systemPrompt);
  } catch {
    session = new AgentSession({ id: sessionId, cwd, model: defaultModel, systemPrompt });
  }
  if (session.thinkingBudgetTokens === undefined) session.thinkingBudgetTokens = thinkingBudgetTokensFromConfig(config);
  session.toolSearchEnabled = resolveToolSearchEnabled(config, isLocalProviderConfig(config));
  session.localModelLeanEnabled = resolveLocalModelLeanEnabled(config, isLocalProviderConfig(config));

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

    await runTurn(session, provider, ui, tools, permissions, userText, selectVisionProvider(config), images);
    await maybeGenerateTitle(session, provider);
    await session.persist();
  } finally {
    await browser.close();
  }

  return { replyText: ui.replyText() };
}
