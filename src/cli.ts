import { Command } from "commander";
import { AgentSession } from "./core/session.js";
import { runTurn, type VisionRoute } from "./core/loop.js";
import type { UIAdapter } from "./ui/adapter.js";
import { createReadlineAdapter } from "./ui/readline-adapter.js";
import { createInkAdapter } from "./ui/ink/ink-adapter.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "./tools/builtin/index.js";
import { PermissionManager } from "./permissions/manager.js";
import { loadPermissionConfig } from "./permissions/config.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltinCommands } from "./commands/builtin.js";
import type { CommandOutcome } from "./commands/types.js";
import { McpClientManager } from "./mcp/client-manager.js";
import { loadMcpServers } from "./mcp/config.js";
import { loadPlugins } from "./plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "./skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "./memory/loader.js";
import { BrowserManager } from "./browser/manager.js";
import type { LlmProvider } from "./core/types.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible-provider.js";
import { loadConfig, type FinanfaConfig } from "./core/config.js";

export const SECURITY_INSTRUCTION =
  "Security: help with authorized security testing, defensive security work, CTF challenges, and security " +
  "education. Decline requests for destructive attack techniques, denial-of-service tooling, mass/automated " +
  "targeting of systems the user doesn't control, supply-chain compromise, or evading detection for malicious " +
  "purposes. Dual-use security tools (exploit code, credential/auth testing, C2-style frameworks) need a clear, " +
  "stated authorization context — a pentest engagement, a CTF, security research on the user's own systems, or " +
  "defensive tooling — before you build or run them; if that context is missing, ask for it rather than refusing " +
  "outright or complying blindly.";

// Split into named sections (each a self-contained topical cluster) instead
// of one continuously-growing string — BASE_SYSTEM_PROMPT below is their
// exact concatenation, so this is a pure reorganization with no prompt
// content change. Every "+"-joined line already had the right
// leading/trailing space to abut its neighbor, so splitting at existing line
// boundaries can't introduce a missing/doubled space anywhere.

/** Identity, the UI-mockup screenshot loop, git/GitHub workflow, the test/fix loop, write_memory. */
export const CORE_BEHAVIOR_PROMPT =
  " You are finanfa-code, a helpful coding assistant with access to file and shell tools. " +
  "Prefer edit_file over write_file for existing files. Always explain what you're about to do before calling a tool. " +
  "When asked to design or mock up a UI, write a clean, single-file HTML/CSS/JS mockup with write_file, then " +
  "close the loop the same way you would for code: open it yourself with preview_html, then browser_navigate to " +
  "that URL and browser_screenshot it — actually look at the rendered result before calling it done, don't assume " +
  "HTML/CSS is right just because it wrote without error. Fix anything wrong (layout, spacing, an unstyled " +
  "element, a script that didn't run) and re-screenshot; repeat until it matches what was asked, same as the " +
  "test/fix loop below. Only then offer the live preview_html link to the user. " +
  "If what's asked for is specifically a React component rather than a plain HTML/CSS/JS mockup, use " +
  "create_artifact instead of hand-writing the CDN script tags/Babel boilerplate with write_file — give it code " +
  "defining a component named App, it handles the scaffold (Tailwind CSS included, use its utility classes " +
  "freely), writes and opens the result the same way preview_html does, and the same screenshot-and-fix loop " +
  "applies before handing it back. Treat visual polish as part of correctness here, not a nice-to-have: real " +
  "spacing and hierarchy, an actual color/type choice, never a bare unstyled page. " +
  "Delegate independent, parallelizable pieces of work to the task tool. " +
  "For any multi-step task, use todo_write up front to plan the steps, and update it as you complete each one. " +
  "web_fetch only returns stripped text — it cannot show you what a page actually looks like. Whenever the user " +
  "asks you to look at, see, describe the appearance of, or take a screenshot/capture of a web page, use " +
  "browser_navigate followed by browser_screenshot instead (call browser_navigate again first if the page isn't " +
  "already open from earlier in the conversation) — never answer a visual request with web_fetch's text dump. " +
  "Use view_image the same way for an existing local image file. " +
  "Prefer the dedicated git_status/git_diff/git_log/git_branch/git_add/git_commit/git_checkout/git_push/" +
  "git_fetch/git_pull/git_stash tools over bash for git operations they cover — bash still works for anything " +
  "else (merge, rebase, ...). " +
  "If mcp__github__* tools are available (a GitHub MCP server is connected), you can carry an issue through to " +
  "a PR end-to-end: read the issue (mcp__github__issue_read), git_checkout a new branch instead of working on " +
  "the default one, make the change, run_tests until it passes, git_add + git_commit, git_push with " +
  "setUpstream: true (it's a new branch), then mcp__github__create_pull_request referencing the issue. Treat " +
  "git_push and opening a PR as real, visible actions on a shared repo — if you're not confident the change is " +
  "ready, say so and check with the user before either, rather than pushing/opening a PR just to make progress. " +
  "After changing code, run run_tests, read any failures carefully, fix the underlying cause, and re-run — " +
  "repeat this test/fix loop until it passes. If the same failure survives about 3 fix attempts, stop and " +
  "explain what's blocking you instead of continuing to guess. " +
  "When the user states a lasting preference, corrects your approach, or shares project context that isn't " +
  "obvious from the code (a deadline, a past incident, why something is built a certain way), use write_memory " +
  "so the next session in this project starts with that context — but not for things already derivable by " +
  "reading the repo or git history. ";

/** Filesystem path boundaries: project/home root, absolute paths, locale folder names, username, `~`. */
export const PATH_GUIDANCE_PROMPT =
  "read_file/write_file/edit_file only work within the current project or the user's home directory, e.g. asked " +
  "to create something \"on the Desktop\" or \"in Documents\" still works with these tools directly — but a path " +
  "genuinely outside the home directory is rejected. If one of these tools rejects a path for that reason, use " +
  "bash instead (e.g. a heredoc) rather than giving up. " +
  "For any location outside the current project, use an absolute path (these tools accept one directly) instead " +
  "of a relative \"../\" guess — the project directory usually isn't one level under the home directory, so a " +
  "relative path from it lands somewhere unexpected. Don't assume a standard folder's name either (\"Desktop\" " +
  "is \"Bureau\" on a French-localized system, etc.) — list the home directory first (e.g. `ls ~`) to find the " +
  "real name before writing into it. If you find an existing project under a folder whose name doesn't match the " +
  "system's actual locale (e.g. work already sitting in \"~/Desktop\" on a French-localized system that also has " +
  "a real \"~/Bureau\"), that's a leftover from a past mistake, not confirmation the name is right — point it out " +
  "to the user and ask whether to keep it there or move it, rather than silently continuing to build in the " +
  "wrong place just because something is already there. Never guess or hardcode a username in a path (e.g. \"/home/someuser/...\") " +
  "— if you don't already know it from this conversation, get the real one first (`bash: echo $HOME` or `whoami`) " +
  "and reuse exactly that value; a guessed username will resolve to the wrong machine's home directory and get " +
  "rejected. `~` is not expanded by these tools — always use the real absolute path, never a literal \"~/...\". ";

/** wait_for_port, start_background_process, list/stop_background_process. */
export const PROCESS_GUIDANCE_PROMPT =
  "When you start a server in the background to test it, use wait_for_port instead of a fixed `sleep N` or a " +
  "hand-rolled bash retry loop — a dev server with a debug/reload mode can take longer to bind its port than a " +
  "guessed sleep duration, and testing too early looks exactly like a crash when it isn't. Only conclude the " +
  "server failed to start if wait_for_port itself times out. " +
  "Use start_background_process (not `bash ... &`/`nohup`/`setsid`) for anything meant to keep running after the " +
  "call returns — a dev server, a watcher. It redirects output and tracks the real PID for you, which manual " +
  "shell backgrounding kept getting wrong in practice: the wrong process killed, an orphaned server left holding " +
  "a port, or a stale log read after the real process had already died without that being obvious from the " +
  "output. Use list_background_processes to check what's running and stop_background_process to shut one down " +
  "by name, instead of guessing at `pkill -f <pattern>`. ";

/** read/write/edit for PDF, Word, Excel, CSV, and Jupyter notebooks. */
export const DOCUMENT_TOOLS_PROMPT =
  "Use read_document (not bash/read_file) to get text out of a PDF, Word (.doc/.docx), Excel (.xlsx), or CSV " +
  "file — the non-CSV ones are binary formats and read_file will return garbage bytes. Legacy .xls isn't " +
  "supported (no lightweight library reads it); legacy .doc is, via a different extractor than .docx. " +
  "Use write_spreadsheet to create a .xlsx from structured row data, " +
  "edit_spreadsheet to update specific cells in one that already exists (read_document first to see current " +
  "values and figure out row/column numbers), and merge_spreadsheets to combine several files into one. " +
  "Use merge_pdf to combine PDFs — there's no tool for editing existing PDF text in place, since that isn't " +
  "reliably possible with any lightweight library; say so rather than attempting something that'll likely " +
  "corrupt the file. write_document creates a new, plain-text-only .docx (no bold/tables/images). edit_document " +
  "does exact-text replacement in an existing .docx, but only works when old_string falls entirely within one " +
  "internal XML run — Word often splits a sentence across several runs, and the tool fails with a clear " +
  "explanation rather than silently missing the edit in that case; prefer a short, distinctive fragment as " +
  "old_string to raise the odds it's captured in a single run. " +
  "Use read_notebook (not read_file) to look at a Jupyter .ipynb file — it shows cells and a summary of their " +
  "outputs instead of the raw, very verbose JSON (execution counts, output MIME bundles, etc.). Use " +
  "edit_notebook to update/insert/delete a cell by 0-based index; updating a cell leaves its old outputs in " +
  "place, now stale until the cell is re-run — same as editing a cell in Jupyter itself without re-executing it. " +
  "Use convert_to_pdf (not write_document/a hand-rolled approach) to turn a Markdown, HTML, or .docx file into " +
  "a PDF — it renders through a real headless browser, so tables/code blocks/formatting come through, unlike " +
  "read_document's plain-text extraction. Use convert_spreadsheet for .xlsx <-> .csv — direction is automatic " +
  "from the source extension; converting from .xlsx exports one sheet (default the first) since CSV has no " +
  "concept of multiple sheets. ";

/** Static analysis, image resizing, the Python REPL, databases, HTTP testing, JS/TS lint+typecheck. */
export const DEV_TOOLS_PROMPT =
  "Use check_python_types (not bash/run_tests) to type-check a Python file or project with Pyright — it's " +
  "static analysis, safe to run any time, not just after a change you're ready to test. " +
  "Use resize_image to resize/convert an image — with both width and height given, the default fit \"inside\" " +
  "scales to fit within that box without cropping, so the actual output size may not exactly match what was " +
  "asked; use fit \"cover\" for an exact-size crop instead. Without outputPath it overwrites the original file. " +
  "Use python_repl for exploratory Python — trying something quickly, iterating on a snippet, inspecting a " +
  "value — instead of `bash: python3 -c \"...\"`, which starts a fresh interpreter every call and throws away " +
  "variables, imports, and function defs between calls. python_repl keeps all of that across calls, the same " +
  "way an interactive session would. Pass reset: true to clear it and start over. It has no interactive stdin, " +
  "so code calling input() will hang until it times out. " +
  "Use query_database to run SQL against SQLite/PostgreSQL/MySQL, picked from the connectionString's scheme " +
  "(sqlite://, postgres://, mysql://) — works against any app's database regardless of what language/framework " +
  "it's written in, since it talks to the database directly. Placeholder syntax isn't portable across engines: " +
  "SQLite/MySQL use \"?\", Postgres uses \"$1\"/\"$2\". \"sqlite::memory:\" does not persist between calls — a " +
  "fresh empty database is created every time. " +
  "Use http_request (not web_fetch) to test an API endpoint — an app you're developing, running locally or " +
  "elsewhere — with any HTTP method, headers, and a body. web_fetch is GET-only and strips HTML for reading a " +
  "page; this doesn't strip anything and returns status, headers, and body as-is, which is what testing an API " +
  "actually needs. " +
  "Use lint_javascript (not bash/run_tests) to run ESLint on a JS/TS file or project. Unlike " +
  "check_python_types/Pyright, this needs the project to already have its own ESLint config — ESLint has no " +
  "usable defaults and refuses to run at all without one, so don't try to work around that by creating one " +
  "yourself unless asked; just report that none was found. " +
  "Use check_typescript_types to run tsc --noEmit on a TS/JS project — it's always whole-project, never a " +
  "single path, since tsc refuses to combine a tsconfig.json with a file given on the command line. " +
  "Use lint_python (not bash) for ruff — it needs `uvx` (from uv) if `ruff` itself isn't already installed; if " +
  "neither is available, tell the user rather than trying to install one yourself.";

export const BASE_SYSTEM_PROMPT =
  SECURITY_INSTRUCTION + CORE_BEHAVIOR_PROMPT + PATH_GUIDANCE_PROMPT + PROCESS_GUIDANCE_PROMPT + DOCUMENT_TOOLS_PROMPT + DEV_TOOLS_PROMPT;
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

export interface CliOptions {
  resume?: string;
  continue?: boolean;
  model?: string;
  yolo?: boolean;
  nonInteractive?: boolean;
  ui: "ink" | "readline";
}

/**
 * Picks the LLM backend. Priority per setting: environment variable > config
 * file (project-local .finanfa-code/config.json, then global
 * ~/.finanfa-code/config.json, see /config) > built-in default.
 *  - provider "anthropic" (default): uses ANTHROPIC_API_KEY / config.apiKey.
 *  - provider "openai-compatible": any server speaking the OpenAI
 *    chat-completions wire format — Ollama (local, free), OpenRouter,
 *    Poolside, LM Studio, vLLM, etc. — needs baseUrl + model (apiKey optional,
 *    e.g. for a local Ollama server that needs no key).
 */
function selectProvider(config: FinanfaConfig): { provider: LlmProvider; defaultModel: string; kind: string } {
  const kind = process.env.FINANFA_PROVIDER ?? config.provider ?? "anthropic";

  if (kind === "openai-compatible") {
    const baseUrl = process.env.FINANFA_BASE_URL ?? config.baseUrl;
    const model = process.env.FINANFA_MODEL ?? config.model;
    const apiKey = process.env.FINANFA_API_KEY ?? config.apiKey;
    if (!baseUrl || !model) {
      throw new Error(
        "provider openai-compatible requires a base URL and model — set FINANFA_BASE_URL/FINANFA_MODEL, " +
          "or /config set baseUrl <url> and /config set model <model>.",
      );
    }
    return { provider: new OpenAiCompatibleProvider({ baseUrl, apiKey }), defaultModel: model, kind };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? config.apiKey;
  return {
    provider: new AnthropicProvider(apiKey),
    defaultModel: config.model ?? DEFAULT_ANTHROPIC_MODEL,
    kind: "anthropic",
  };
}

/**
 * Optional second provider used only for the turn right after a vision tool
 * (browser_screenshot, view_image) returns an image — see VisionRoute in
 * loop.ts. Unset unless FINANFA_VISION_MODEL/config.visionModel is
 * configured; the primary provider's apiKey is never reused here, since it's
 * scoped to the primary provider's own service and reusing it for a
 * different provider kind would send the wrong secret to the wrong API.
 */
function selectVisionProvider(config: FinanfaConfig): { provider: LlmProvider; model: string } | undefined {
  const model = process.env.FINANFA_VISION_MODEL ?? config.visionModel;
  if (!model) return undefined;

  const kind = process.env.FINANFA_VISION_PROVIDER ?? config.visionProvider ?? "anthropic";
  if (kind === "openai-compatible") {
    const baseUrl = process.env.FINANFA_VISION_BASE_URL ?? config.visionBaseUrl;
    const apiKey = process.env.FINANFA_VISION_API_KEY ?? config.visionApiKey;
    if (!baseUrl) {
      throw new Error(
        "visionProvider openai-compatible requires a base URL — set FINANFA_VISION_BASE_URL, " +
          "or /config set visionBaseUrl <url>.",
      );
    }
    return { provider: new OpenAiCompatibleProvider({ baseUrl, apiKey }), model };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? config.visionApiKey;
  return { provider: new AnthropicProvider(apiKey), model };
}

function createUi(mode: "ink" | "readline"): UIAdapter {
  // Ink needs an interactive TTY to manage raw input/output; fall back to the
  // readline adapter automatically when stdin isn't one (e.g. CI, pipes).
  if (mode === "ink" && process.stdin.isTTY) return createInkAdapter();
  return createReadlineAdapter();
}

export async function resolveSession(
  cwd: string,
  opts: CliOptions,
  model: string,
  systemPrompt: string,
  ui: UIAdapter,
): Promise<AgentSession> {
  const idToResume = opts.resume ?? (opts.continue ? await AgentSession.findLatest(cwd) : undefined);
  if (idToResume) {
    try {
      return await AgentSession.resume(cwd, idToResume, systemPrompt);
    } catch (err) {
      // A stale/typo'd --resume id, or a corrupted session file, used to
      // crash the whole CLI at startup with a raw stack trace before the UI
      // was even usable. Warn and fall back to a fresh session instead —
      // same "warn and continue" policy as AgentSession.persist().
      ui.writeError(
        `Could not resume session "${idToResume}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
      );
    }
  }
  return new AgentSession({ cwd, model, systemPrompt });
}

/**
 * Persists the session and closes MCP connections before exiting, instead of
 * letting SIGINT/SIGTERM kill the process mid-write. Ink's raw-mode Ctrl+C
 * handling is redirected into a real SIGINT (see App.tsx) so both UI modes
 * go through this same path.
 */
function registerShutdownHandlers(
  session: AgentSession,
  mcp: McpClientManager,
  browser: BrowserManager,
  ui: UIAdapter,
): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.writeSystem("Interrupted — saving session and closing connections...");
    try {
      await session.persist();
    } catch (err) {
      ui.writeError(`Failed to save session: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await mcp.disconnectAll();
    } catch {
      // Best-effort on the way out.
    }
    await browser.close().catch(() => {});
    ui.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function connectMcpServers(cwd: string, mcp: McpClientManager, ui: UIAdapter): Promise<void> {
  const servers = await loadMcpServers(cwd);
  for (const server of servers) {
    try {
      await mcp.connect(server);
    } catch (err) {
      ui.writeError(`Failed to connect MCP server "${server.name}": ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("finanfa")
    .description("finanfa-code: a from-scratch AI coding agent CLI")
    .option("-r, --resume <sessionId>", "resume a specific session by id")
    .option("-c, --continue", "resume the most recent session for this directory")
    .option("-m, --model <model>", "model to use (defaults depend on the active provider)")
    .option("--yolo", "auto-approve every tool call without prompting (dangerous)")
    .option("--non-interactive", "never prompt; auto-deny anything not pre-allowed by config")
    .option("--ui <mode>", "terminal UI: ink or readline", "ink")
    .parse(argv);

  const opts = program.opts<CliOptions>();
  const cwd = process.cwd();
  const ui = createUi(opts.ui);

  const config = await loadConfig(cwd);
  const { provider, defaultModel, kind: providerKind } = selectProvider(config);
  const model = opts.model ?? defaultModel;
  const visionRoute = selectVisionProvider(config);

  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));

  tools.register(writeMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) tools.register(createReadMemoryTool(cwd));

  const systemPrompt = BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories);

  const session = await resolveSession(cwd, opts, model, systemPrompt, ui);

  const permissionConfig = await loadPermissionConfig(cwd);
  const permissions = new PermissionManager({
    config: permissionConfig,
    ui,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
  });

  const mcp = new McpClientManager();
  const browser = new BrowserManager();
  registerShutdownHandlers(session, mcp, browser, ui);
  await connectMcpServers(cwd, mcp, ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  registerStatefulBuiltins(tools, { provider, permissions, ui, model, cwd, browser });

  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  const plugins = await loadPlugins(cwd, tools, commands);
  ui.setCommands(commands.list());

  ui.writeSystem(`finanfa-code — session ${session.id} (${session.model} via ${providerKind})`);
  ui.writeSystem(`Tools: ${tools.list().map((t) => t.name).join(", ")}`);
  if (mcp.connectedServers().length > 0) ui.writeSystem(`MCP servers: ${mcp.connectedServers().join(", ")}`);
  if (plugins.length > 0) ui.writeSystem(`Plugins: ${plugins.join(", ")}`);
  if (opts.yolo) ui.writeSystem("⚠ --yolo: all tool calls will be auto-approved");
  if (visionRoute) ui.writeSystem(`Vision routing: image turns use ${visionRoute.model}`);
  ui.writeSystem(`Type / to see available commands, or /help for details.`);

  await repl({ session, provider, ui, tools, permissions, mcp, commands, cwd, visionRoute });
  await mcp.disconnectAll();
  await browser.close();
  ui.close();
}

interface ReplDeps {
  session: AgentSession;
  provider: LlmProvider;
  ui: UIAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  commands: CommandRegistry;
  cwd: string;
  visionRoute?: VisionRoute;
}

async function runSlashCommand(deps: ReplDeps, trimmed: string): Promise<CommandOutcome> {
  const { ui, commands } = deps;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  const handler = commands.get(name);
  if (!handler) {
    const available = commands.names().map((n) => `/${n}`).join(", ");
    ui.writeError(`Unknown command "/${name}". Available: ${available}`);
    return "continue";
  }
  return handler({ ...deps, args: rest.join(" ") });
}

async function repl(deps: ReplDeps): Promise<void> {
  const { ui, session, provider, tools, permissions, visionRoute } = deps;

  for (;;) {
    const input = await ui.askUser("\n> ");
    const trimmed = input.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("/")) {
      if ((await runSlashCommand(deps, trimmed)) === "exit") return;
      continue;
    }

    try {
      await runTurn(session, provider, ui, tools, permissions, trimmed, visionRoute);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
  }
}
