import type { ToolContext, ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Real tmux session/pane control, wrapping the actual `tmux` CLI — lets
// the agent drive an interactive program (a REPL, an install wizard, a
// long-running dev server whose prompts need answering) the way a human
// at a terminal would, instead of only ever running a command to
// completion and reading its final output (bash.ts/background-process.ts
// cover the "run to completion" and "start and forget" cases; this is the
// missing "attach and interact with an already-running interactive
// session" one — same real gap OpenClaw's own tmux skill closes).
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TmuxToolOptions {
  binary?: string;
}

async function runTmux(binary: string, args: string[], ctx: ToolContext, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return runSubprocess(binary, { cwd: ctx.cwd, sessionId: ctx.sessionId, timeoutMs, signal: ctx.signal, args, format: "compact" });
}

interface TmuxListSessionsInput {}

export function createTmuxListSessionsTool(options: TmuxToolOptions = {}): ToolDefinition<TmuxListSessionsInput> {
  const binary = options.binary ?? "tmux";
  return {
    name: "tmux_list_sessions",
    description: "List real tmux sessions currently running on this machine (name, window/pane count, creation time, attached status).",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list tmux sessions",
    async handler(_input, ctx) {
      const result = await runTmux(binary, ["list-sessions"], ctx);
      // tmux exits 1 with "no server running on ..." when there are simply
      // no sessions yet — a real, common, non-error state (nothing to
      // list), not a tool failure.
      if (result.isError && /no server running/i.test(result.content)) {
        return { content: "No tmux sessions running.", isError: false };
      }
      return result;
    },
  };
}

interface TmuxNewSessionInput {
  name: string;
  command?: string;
  cwd?: string;
}

export function createTmuxNewSessionTool(options: TmuxToolOptions = {}): ToolDefinition<TmuxNewSessionInput> {
  const binary = options.binary ?? "tmux";
  return {
    name: "tmux_new_session",
    description:
      "Start a new detached tmux session, optionally running a command in it (e.g. an interactive REPL, a dev server, an install wizard). " +
      "Use tmux_send_keys/tmux_capture_pane afterward to interact with it.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name — used to target it from tmux_send_keys/tmux_capture_pane/tmux_kill_session" },
        command: { type: "string", description: "Command to run in the new session's shell (default: just an idle shell)" },
        cwd: { type: "string", description: "Working directory for the session, relative to the project root (defaults to the project root)" },
      },
      required: ["name"],
    },
    riskKey: (input) => `tmux_new_session:${input.name}`,
    describeCall: (input) => `start tmux session "${input.name}"${input.command ? `: ${input.command}` : ""}`,
    async handler(input, ctx) {
      const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
      const args = ["new-session", "-d", "-s", input.name, "-c", cwd];
      if (input.command) args.push(input.command);
      const result = await runTmux(binary, args, ctx);
      if (result.isError) return result;
      return { content: `Started tmux session "${input.name}".`, isError: false };
    },
  };
}

interface TmuxSendKeysInput {
  target: string;
  keys: string;
  enter?: boolean;
}

export function createTmuxSendKeysTool(options: TmuxToolOptions = {}): ToolDefinition<TmuxSendKeysInput> {
  const binary = options.binary ?? "tmux";
  return {
    name: "tmux_send_keys",
    description:
      "Send real keystrokes to a tmux session/pane — types text into whatever interactive program is running there (answer a prompt, drive a REPL, " +
      "confirm an install step). Use tmux_capture_pane afterward to see the result.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target session/pane, e.g. a session name from tmux_new_session, or 'session:window.pane'" },
        keys: { type: "string", description: "Literal text to type" },
        enter: { type: "boolean", description: "Also send Enter after the text (default true)" },
      },
      required: ["target", "keys"],
    },
    riskKey: (input) => `tmux_send_keys:${input.target}`,
    describeCall: (input) => `send keys to tmux ${input.target}: "${input.keys}"`,
    async handler(input, ctx) {
      const args = ["send-keys", "-t", input.target, "-l", input.keys];
      const result = await runTmux(binary, args, ctx);
      if (result.isError) return result;
      if (input.enter !== false) {
        const enterResult = await runTmux(binary, ["send-keys", "-t", input.target, "Enter"], ctx);
        if (enterResult.isError) return enterResult;
      }
      return { content: `Sent keys to ${input.target}.`, isError: false };
    },
  };
}

interface TmuxCapturePaneInput {
  target: string;
  lines?: number;
}

export function createTmuxCapturePaneTool(options: TmuxToolOptions = {}): ToolDefinition<TmuxCapturePaneInput> {
  const binary = options.binary ?? "tmux";
  return {
    name: "tmux_capture_pane",
    description: "Capture the real current (and recent scrollback) output of a tmux session/pane — how you read what an interactive program has printed since the last check.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target session/pane, e.g. a session name from tmux_new_session" },
        lines: { type: "number", description: "How many lines of scrollback to include in addition to the visible pane (default: visible pane only)" },
      },
      required: ["target"],
    },
    describeCall: (input) => `capture tmux pane ${input.target}`,
    async handler(input, ctx) {
      const args = ["capture-pane", "-t", input.target, "-p"];
      if (input.lines) args.push("-S", `-${input.lines}`);
      return runTmux(binary, args, ctx);
    },
  };
}

interface TmuxKillSessionInput {
  name: string;
}

export function createTmuxKillSessionTool(options: TmuxToolOptions = {}): ToolDefinition<TmuxKillSessionInput> {
  const binary = options.binary ?? "tmux";
  return {
    name: "tmux_kill_session",
    description: "Terminate a real tmux session and everything running inside it.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Session name to kill" } },
      required: ["name"],
    },
    riskKey: (input) => `tmux_kill_session:${input.name}`,
    describeCall: (input) => `kill tmux session "${input.name}"`,
    async handler(input, ctx) {
      const result = await runTmux(binary, ["kill-session", "-t", input.name], ctx);
      if (result.isError) return result;
      return { content: `Killed tmux session "${input.name}".`, isError: false };
    },
  };
}

export function createTmuxTools(options: TmuxToolOptions = {}): ToolDefinition[] {
  return [
    createTmuxListSessionsTool(options),
    createTmuxNewSessionTool(options),
    createTmuxSendKeysTool(options),
    createTmuxCapturePaneTool(options),
    createTmuxKillSessionTool(options),
  ];
}
