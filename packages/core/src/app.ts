// Shared composition logic for anything hosting the finanfa-code agent
// (the CLI, the web server) — system prompts, provider selection, and MCP
// connect-at-startup. Kept here instead of duplicated per-frontend so a
// prompt/config change only has to happen once.
import type { LlmProvider } from "./core/types.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible-provider.js";
import { GeminiProvider } from "./providers/gemini-provider.js";
import { AzureOpenAiProvider } from "./providers/azure-openai-provider.js";
import { AmazonBedrockProvider } from "./providers/amazon-bedrock-provider.js";
import { GoogleVertexProvider } from "./providers/google-vertex-provider.js";
import { CohereProvider } from "./providers/cohere-provider.js";
import { GithubCopilotProvider } from "./providers/github-copilot-provider.js";
import type { FinanfaConfig } from "./core/config.js";
import { McpClientManager, NeedsAuthorizationError } from "./mcp/client-manager.js";
import { loadMcpServers } from "./mcp/config.js";
import type { UIAdapter } from "./ui/adapter.js";
import { resolveProviderKindAlias } from "./core/model-capabilities.js";
import { ensureLocalTextModelServer, type LocalModelStatus } from "./core/local-model-manager.js";
import path from "node:path";

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
  "Plain conversation — a greeting, a question about something unrelated to the project, chit-chat — gets a " +
  "normal reply with no tool calls, exactly like you'd answer without any of these tools available. Only look " +
  "at the project (list files, read something, check git status) when the user's actual request needs that " +
  "context to answer — never proactively, and never just because a project directory happens to be open. " +
  "Prefer edit_file over write_file for existing files. When a single file needs several separate changes, use " +
  "multi_edit_file instead of several edit_file calls — it applies them atomically (all or none) and needs only " +
  "one confirmation. Always explain what you're about to do before calling a tool. " +
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
  "If the user turned on plan mode (/plan on), only read-only tools work — every mutating tool is blocked " +
  "automatically until you call exit_plan_mode with your full plan and the user approves it; use the time to " +
  "research thoroughly (read_file/grep/glob/recall_past_sessions/etc.) before presenting the plan, and if it's " +
  "declined, revise it based on the feedback and call exit_plan_mode again rather than trying a blocked tool. " +
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
  "explain what's blocking you instead of continuing to guess. This still applies to a brand-new project you " +
  "just scaffolded, not just a change to existing code — even with no test suite yet, actually try to build " +
  "or run what you wrote (cargo build, go build ./..., node <file>, python <file>, etc., or run_tests, which " +
  "compiles as a side effect for cargo/go even with zero tests) before telling the user it's done. Writing a " +
  "file without a tool error is not the same as it actually running — verify it, don't assume it from a clean " +
  "write_file result. " +
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
  "by name, instead of guessing at `pkill -f <pattern>`. " +
  "Before installing or downloading a whole toolchain/SDK for a task (a language runtime, a framework's CLI, " +
  "a large dependency) — real, reported waste: cloning an entire multi-GB SDK from source when a system " +
  "install already existed — check what's already on the system first: `which <tool>`/`command -v <tool>`, " +
  "common install locations, a version manager already in use for that language. If something's installed but " +
  "fails to run (a permission/sandbox error, not a missing-file error), that's usually an environment " +
  "constraint worth understanding and noting (e.g. via write_memory, so a later session doesn't rediscover it " +
  "from scratch) rather than an automatic signal to fetch a fresh copy — a full reinstall is the expensive " +
  "option, not the default one. ";

/** read/write/edit for PDF, Word, Excel, CSV, and Jupyter notebooks. */
export const DOCUMENT_TOOLS_PROMPT =
  "Use read_document (not bash/read_file) to get text out of a PDF, Word (.doc/.docx), Excel (.xlsx), or CSV " +
  "file — the non-CSV ones are binary formats and read_file will return garbage bytes. Legacy .xls isn't " +
  "supported (no lightweight library reads it); legacy .doc is, via a different extractor than .docx. " +
  "Use write_spreadsheet to create a .xlsx from structured row data, " +
  "edit_spreadsheet to update specific cells in one that already exists (read_document first to see current " +
  "values and figure out row/column numbers), and merge_spreadsheets to combine several files into one. " +
  "Use merge_pdf to combine PDFs and split_pdf for the reverse (one file per page, or a single page with " +
  "`page`) — there's no tool for editing existing PDF text in place, since that isn't reliably possible with " +
  "any lightweight library; say so rather than attempting something that'll likely corrupt the file. Use " +
  "images_to_pdf to combine PNG/JPEG images into a PDF, one page per image sized to match it — other image " +
  "formats aren't supported, convert with resize_image first. write_document creates a new, plain-text-only " +
  ".docx (no bold/tables/images). edit_document " +
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
  "Use resize_image to resize and/or convert an image's format — with both width and height given, the " +
  "default fit \"inside\" scales to fit within that box without cropping, so the actual output size may not " +
  "exactly match what was asked; use fit \"cover\" for an exact-size crop instead. Give format alone (no " +
  "width/height) for a pure format conversion at the original size. Without outputPath it overwrites the " +
  "original file. " +
  "Use convert_pdf_to_image (not preview_html/browser_screenshot) to rasterize PDF pages to PNG/JPEG — it " +
  "shells out to pdftoppm (poppler-utils) since headless Chromium can't render a PDF inline (navigating to " +
  "one triggers a download instead), and needs pdftoppm installed; tell the user if it's missing rather than " +
  "trying to install it yourself. Note pdftoppm's own -jpeg flag writes a .jpg extension, not .jpeg. " +
  "Use ocr_image (via Tesseract) to read text out of a photo, screenshot, or scanned page — read_document " +
  "can't help with a scanned PDF (no real text layer), so convert_pdf_to_image it first, then ocr_image each " +
  "page. lang defaults to \"eng\" and must be an installed Tesseract language pack; tell the user which one " +
  "to install if it's missing, don't try to install it yourself. " +
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
  "neither is available, tell the user rather than trying to install one yourself. " +
  "Use translate_text (not your own knowledge) whenever asked to translate something, especially into or out " +
  "of Fon or Yoruba — your own training data and web search both cover these unreliably, which is the whole " +
  "reason this tool exists; it works with no configuration needed (a free Google Translate backend by default). " +
  "Bariba and Dendi aren't supported by any backend right now — say so plainly rather than guessing a " +
  "translation yourself when the tool reports that. " +
  "Use text_to_speech to turn text into a spoken MP3, same free backend, no configuration needed. Its voice " +
  "coverage is narrower than translate_text's language coverage, though — Fon and Yoruba translate fine but " +
  "currently have no TTS voice, which only surfaces as a failure when you actually call it (there's no way to " +
  "know in advance); say so plainly rather than retrying repeatedly when that happens.";

export const BASE_SYSTEM_PROMPT =
  SECURITY_INSTRUCTION + CORE_BEHAVIOR_PROMPT + PATH_GUIDANCE_PROMPT + PROCESS_GUIDANCE_PROMPT + DOCUMENT_TOOLS_PROMPT + DEV_TOOLS_PROMPT;

/**
 * Real, reported symptom: a tiny local model (Ternary-Bonsai 1.7B/4B via
 * llama.cpp) given the full BASE_SYSTEM_PROMPT above answered a plain
 * "bonjour" with an off-topic, incoherent refusal fixated on the security
 * paragraph — the same overwhelmed-by-prompt-size problem
 * LOCAL_MODEL_LEAN_EXCLUDED_TOOLS already addresses for the tool list, but
 * for the system prompt text itself, which tool trimming alone doesn't
 * touch. Used only when the same local-model gate that drives
 * session.localModelLeanEnabled (resolveLocalModelLeanEnabled +
 * isLocalProviderConfig — see the four call sites that build a system
 * prompt) says so; every non-local/remote session keeps BASE_SYSTEM_PROMPT
 * byte-for-byte. Keeps only what's load-bearing: identity, one condensed
 * security-refusal sentence, and the test/fix loop discipline (existing
 * tests assert the agent actually runs tests before claiming success, and
 * that applies to local-model sessions too, not a separate code path) —
 * drops the UI-mockup/browser-screenshot loop, the GitHub PR workflow, path
 * localization edge cases, and the whole document/dev-tools tool tour,
 * since a small model is unlikely to reliably use those anyway and every
 * word here is prefill cost paid on every single turn.
 */
export const LOCAL_MODEL_LEAN_SYSTEM_PROMPT =
  " You are finanfa-code, a coding assistant with file and shell tools (read_file, write_file, edit_file, " +
  "multi_edit_file, bash, and git_status/git_diff/git_add/git_commit/git_push/etc.). Plain conversation — a " +
  "greeting, chit-chat, a question unrelated to the project — gets a normal reply with no tool calls; only look " +
  "at the project when the user's request actually needs that context, never proactively. Prefer edit_file over " +
  "write_file for an existing file; use multi_edit_file instead of several edit_file calls when one file needs " +
  "several separate changes. " +
  "Security: help with authorized security testing, defensive security work, CTFs, and security education; " +
  "decline destructive attack techniques, malicious targeting of systems the user doesn't control, or evading " +
  "detection for malicious purposes. " +
  "After changing code, run the tests (run_tests, or build/run it if there's no test suite yet) and read any " +
  "failure carefully — fix the actual cause and re-run rather than assuming a clean write means it works. If the " +
  "same failure survives about 3 fix attempts, stop and explain what's blocking you instead of continuing to " +
  "guess. " +
  "When the user states a lasting preference or shares project context that isn't obvious from the code, use " +
  "write_memory so the next session starts with it. ";

/** Picks BASE_SYSTEM_PROMPT vs LOCAL_MODEL_LEAN_SYSTEM_PROMPT — pass the exact same value already computed for session.localModelLeanEnabled (resolveLocalModelLeanEnabled(config, isLocalProviderConfig(config))) so the prompt and the tool-trimming gate never disagree about whether a session is "local". */
export function baseSystemPromptFor(localModelLeanEnabled: boolean): string {
  return localModelLeanEnabled ? LOCAL_MODEL_LEAN_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_COHERE_MODEL = "command-r-plus-08-2024";
const DEFAULT_GITHUB_COPILOT_MODEL = "gpt-4o";

/** FINANFA_API_KEYS is comma- or newline-separated (a community pasting several keys at once) — undefined if unset, so it doesn't shadow config.apiKeys with an empty array. */
export function parseApiKeys(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const keys = raw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Real, reported case: even OpenAiCompatibleProvider's own generous default
 * stream-idle timeout wasn't enough for a small local model composing a
 * large tool call (an entire file as a write_file argument) with no
 * intermediate bytes on an especially slow box — an escape hatch for a
 * setup slower than that default, without needing a code change.
 */
export function parseStreamIdleTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Picks the LLM backend. Priority per setting: TEXT_MODEL_* environment
 * variable (the local-first naming — see project memory's model-router
 * roadmap) > legacy FINANFA_* environment variable > config file
 * (project-local .finanfa-code/config.json, then global
 * ~/.finanfa-code/config.json, see /config) > built-in default.
 *  - provider "anthropic" (default): uses ANTHROPIC_API_KEY / config.apiKey.
 *  - provider "openai-compatible" (or an alias — see resolveProviderKindAlias:
 *    "llama_cpp", "mlx", "ollama", "vllm", "lmstudio", "openrouter" all mean
 *    this): any server speaking the OpenAI chat-completions wire format —
 *    needs baseUrl + model (apiKey optional, e.g. for a local server that
 *    needs no key).
 */
export function selectProvider(config: FinanfaConfig): { provider: LlmProvider; defaultModel: string; kind: string } {
  const kind = resolveProviderKindAlias(
    process.env.TEXT_MODEL_PROVIDER ?? process.env.FINANFA_PROVIDER ?? config.provider ?? "anthropic",
  );

  if (kind === "openai-compatible") {
    const baseUrl = process.env.TEXT_MODEL_BASE_URL ?? process.env.FINANFA_BASE_URL ?? config.baseUrl;
    const model = process.env.TEXT_MODEL_NAME ?? process.env.FINANFA_MODEL ?? config.model;
    const apiKey = process.env.FINANFA_API_KEY ?? config.apiKey;
    const apiKeys = parseApiKeys(process.env.FINANFA_API_KEYS) ?? config.apiKeys;
    const streamIdleTimeoutMs = parseStreamIdleTimeoutMs(process.env.FINANFA_STREAM_IDLE_TIMEOUT_MS);
    if (!baseUrl || !model) {
      throw new Error(
        "provider openai-compatible requires a base URL and model — set TEXT_MODEL_BASE_URL/TEXT_MODEL_NAME " +
          "(or the older FINANFA_BASE_URL/FINANFA_MODEL), or /config set baseUrl <url> and /config set model <model>.",
      );
    }
    return { provider: new OpenAiCompatibleProvider({ baseUrl, apiKey, apiKeys, streamIdleTimeoutMs }), defaultModel: model, kind };
  }

  if (kind === "azure-openai") {
    const endpoint = process.env.FINANFA_BASE_URL ?? config.baseUrl;
    const model = process.env.FINANFA_MODEL ?? config.model; // the Azure deployment name
    const apiKey = process.env.FINANFA_API_KEY ?? config.apiKey;
    const apiVersion = process.env.FINANFA_AZURE_API_VERSION ?? config.azureApiVersion;
    if (!endpoint || !model || !apiKey) {
      throw new Error(
        "provider azure-openai requires an endpoint, deployment name (as the model), and API key — set " +
          "FINANFA_BASE_URL/FINANFA_MODEL/FINANFA_API_KEY, or /config set baseUrl <endpoint>, /config set " +
          "model <deployment>, and /config set apiKey <key>.",
      );
    }
    return { provider: new AzureOpenAiProvider({ apiKey, endpoint, apiVersion }), defaultModel: model, kind };
  }

  if (kind === "gemini") {
    const apiKey = process.env.FINANFA_API_KEY ?? config.apiKey;
    const model = process.env.FINANFA_MODEL ?? config.model ?? DEFAULT_GEMINI_MODEL;
    if (!apiKey) {
      throw new Error("provider gemini requires an API key — set FINANFA_API_KEY, or /config set apiKey <key>.");
    }
    return { provider: new GeminiProvider({ apiKey }), defaultModel: model, kind };
  }

  if (kind === "amazon-bedrock") {
    const model = process.env.FINANFA_MODEL ?? config.model;
    const region = process.env.FINANFA_AWS_REGION ?? config.awsRegion;
    if (!model) {
      throw new Error(
        "provider amazon-bedrock requires a model — set FINANFA_MODEL, or /config set model <bedrock-model-id>. " +
          "AWS credentials/region come from the standard AWS environment (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/" +
          "AWS_REGION, or ~/.aws/credentials) unless overridden with FINANFA_AWS_REGION or /config set awsRegion.",
      );
    }
    return { provider: new AmazonBedrockProvider({ region }), defaultModel: model, kind };
  }

  if (kind === "github-copilot") {
    const githubToken = process.env.FINANFA_GITHUB_COPILOT_TOKEN ?? config.githubCopilotToken;
    const model = process.env.FINANFA_MODEL ?? config.model ?? DEFAULT_GITHUB_COPILOT_MODEL;
    if (!githubToken) {
      throw new Error(
        "provider github-copilot requires a GitHub token with Copilot access — set FINANFA_GITHUB_COPILOT_TOKEN, " +
          "or /config set githubCopilotToken <token>. See the README's GitHub Copilot setup section for how to " +
          "obtain one via the device-authorization flow.",
      );
    }
    return { provider: new GithubCopilotProvider({ githubToken }), defaultModel: model, kind };
  }

  if (kind === "cohere") {
    const apiKey = process.env.FINANFA_API_KEY ?? config.apiKey;
    const model = process.env.FINANFA_MODEL ?? config.model ?? DEFAULT_COHERE_MODEL;
    const baseUrl = process.env.FINANFA_BASE_URL ?? config.baseUrl;
    if (!apiKey) {
      throw new Error("provider cohere requires an API key — set FINANFA_API_KEY, or /config set apiKey <key>.");
    }
    return { provider: new CohereProvider(apiKey, baseUrl), defaultModel: model, kind };
  }

  if (kind === "google-vertex") {
    const model = process.env.FINANFA_MODEL ?? config.model;
    const region = process.env.FINANFA_VERTEX_REGION ?? config.vertexRegion;
    const projectId = process.env.FINANFA_VERTEX_PROJECT_ID ?? config.vertexProjectId;
    if (!model || !region || !projectId) {
      throw new Error(
        "provider google-vertex requires a model, region, and GCP project id — set FINANFA_MODEL/" +
          "FINANFA_VERTEX_REGION/FINANFA_VERTEX_PROJECT_ID, or /config set model/vertexRegion/vertexProjectId. " +
          "Auth uses standard Google Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, or " +
          "`gcloud auth application-default login`).",
      );
    }
    return { provider: new GoogleVertexProvider({ region, projectId }), defaultModel: model, kind };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey ?? config.apiKey;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID ?? config.anthropicWorkspaceId;
  return {
    provider: new AnthropicProvider(apiKey, workspaceId),
    defaultModel: config.model ?? DEFAULT_ANTHROPIC_MODEL,
    kind: "anthropic",
  };
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * True when whatever selectProvider(config) would actually resolve to
 * points at a local server — openai-compatible is the only family that
 * can point anywhere at all, including a local one (Ollama/LM Studio/
 * llama.cpp/vLLM/a raw MLX server), so every other kind is never local.
 * Mirrors selectProvider's own env/config precedence for that one branch
 * rather than changing its return shape. Used to auto-enable Tool Search
 * (session.toolSearchEnabled) for a local/small model without the user
 * needing to configure anything — see tool-search.ts's own header
 * comment for the real, measured problem this closes specifically for
 * this case (a small local model's prefill cost scaling with the total
 * tool count).
 */
export function isLocalProviderConfig(config: FinanfaConfig): boolean {
  const kind = resolveProviderKindAlias(
    process.env.TEXT_MODEL_PROVIDER ?? process.env.FINANFA_PROVIDER ?? config.provider ?? "anthropic",
  );
  if (kind !== "openai-compatible") return false;
  const baseUrl = process.env.TEXT_MODEL_BASE_URL ?? process.env.FINANFA_BASE_URL ?? config.baseUrl;
  if (!baseUrl) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Called once at process startup (CLI/web-server main, not per-session or
 * per-turn): if the resolved text provider is local and config.textModelPath
 * is set, makes sure the right model is actually being served there before
 * the first real request ever reaches it — see local-model-manager.ts's own
 * header comment for the real, reported friction this closes (getting
 * llama.cpp itself running was the hard part, not configuring finanfa-code
 * to talk to it). Never throws: a failure here just means the normal
 * "couldn't reach that model" error happens naturally on first use, same as
 * before this existed — this is a convenience, not a new hard requirement.
 */
/** Reports a LocalModelStatus to the user — shared by the startup check and the model-switch check below, so both give the same guidance (including a real `hf download` command when the file is missing and textModelHfRepo/textModelHfFile are configured, rather than a dead end). */
function reportLocalModelStatus(
  result: LocalModelStatus,
  baseUrl: string,
  config: FinanfaConfig,
  ui: Pick<UIAdapter, "writeSystem" | "writeError">,
): void {
  switch (result.state) {
    case "started":
      ui.writeSystem(`Started llama-server serving ${result.modelId} at ${baseUrl}.`);
      break;
    case "restarted":
      ui.writeSystem(`Switched the local model server from ${result.previousModelId} to ${result.modelId} at ${baseUrl}.`);
      break;
    case "already-running-different-model":
      ui.writeError(
        `${baseUrl} is already serving "${result.runningModelId}", not the configured "${result.expected}" — ` +
          `stop that server yourself if you want finanfa-code to load the right model there.`,
      );
      break;
    case "missing-binary":
      ui.writeError(`Can't auto-start the local text model: "${result.binary}" isn't installed or isn't on PATH.`);
      break;
    case "missing-model-file": {
      const hfRepo = config.textModelHfRepo;
      const hfFile = config.textModelHfFile;
      const howToGet =
        hfRepo && hfFile
          ? ` Get it with: hf download ${hfRepo} ${hfFile} --local-dir "${path.dirname(result.path)}"`
          : " (check textModelPath/TEXT_MODEL_PATH, or set textModelHfRepo/textModelHfFile for a download command here).";
      ui.writeError(`Can't auto-start the local text model: no file at ${result.path}.${howToGet}`);
      break;
    }
    case "start-failed":
      ui.writeError(`Failed to auto-start the local text model: ${result.message}`);
      break;
    case "already-running-correct":
      break; // Nothing to say — it was already right.
  }
}

/**
 * Called once at process startup (CLI/web-server main, not per-session or
 * per-turn): if the resolved text provider is local and config.textModelPath
 * is set, makes sure the right model is actually being served there before
 * the first real request ever reaches it — see local-model-manager.ts's own
 * header comment for the real, reported friction this closes (getting
 * llama.cpp itself running was the hard part, not configuring finanfa-code
 * to talk to it). Never throws: a failure here just means the normal
 * "couldn't reach that model" error happens naturally on first use, same as
 * before this existed — this is a convenience, not a new hard requirement.
 */
export async function ensureConfiguredLocalTextModel(
  config: FinanfaConfig,
  ui: Pick<UIAdapter, "writeSystem" | "writeError">,
): Promise<void> {
  if (!isLocalProviderConfig(config)) return;
  const modelPath = process.env.TEXT_MODEL_PATH ?? config.textModelPath;
  if (!modelPath) return;

  const baseUrl = process.env.TEXT_MODEL_BASE_URL ?? process.env.FINANFA_BASE_URL ?? config.baseUrl;
  const modelName = process.env.TEXT_MODEL_NAME ?? process.env.FINANFA_MODEL ?? config.model;
  if (!baseUrl || !modelName) return;

  try {
    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName,
      binary: process.env.TEXT_MODEL_BINARY ?? config.textModelBinary,
      contextSize: config.textModelContextSize ? Number(config.textModelContextSize) : undefined,
    });
    reportLocalModelStatus(result, baseUrl, config, ui);
  } catch (err) {
    ui.writeError(`Failed to auto-start the local text model: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Result of ensureLocalTextModelForSwitch: `handled` is "this model name was
 * in config.localTextModelPaths so a local-server switch was actually
 * attempted" (the old boolean return); `ok` is the real, reported gap this
 * type closes — whether that attempt actually succeeded. A caller that only
 * checked `handled` (or the old bare boolean) couldn't tell an
 * "already-running-different-model"/"missing-binary"/"missing-model-file"/
 * "start-failed" refusal apart from a real success, since both left
 * `handled` true — see the set_model bug this was reported against: the
 * server refused to switch (a different local model was already running and
 * finanfa-code wouldn't kill a process it didn't start) yet the caller still
 * committed the new model as active, so the UI showed the picked model while
 * every request kept going to the old one underneath it. `handled` is false
 * (and `ok` true — nothing was attempted, so nothing failed) when this model
 * name isn't a local-server switch at all.
 */
export type EnsureLocalTextModelForSwitchResult =
  | { handled: false; ok: true; status?: undefined }
  | { handled: true; ok: boolean; status: LocalModelStatus };

/**
 * Called when the user deliberately switches to a *different* local model
 * mid-session (the `/models` command, or the web UI/mobile app's model
 * picker sending set_model) — see local-model-manager.ts's
 * restartIfDifferent: unlike the startup check above, a mismatch here is
 * expected (that's the whole point of switching), so this actively stops
 * whatever this same module previously started on that port and loads the
 * newly-picked model instead. Still never touches a server it didn't spawn
 * itself. A no-op (`handled: false`) unless config.localTextModelPaths has an
 * entry for the newly-picked model name — most model switches (a different
 * Anthropic model, a different Ollama model, etc.) have nothing to do with
 * the llama.cpp-served local text model slot at all. When `handled` is true,
 * check `ok` before treating the switch as having actually happened — see
 * EnsureLocalTextModelForSwitchResult's doc for why.
 */
export async function ensureLocalTextModelForSwitch(
  config: FinanfaConfig,
  newModelName: string,
  ui: Pick<UIAdapter, "writeSystem" | "writeError">,
): Promise<EnsureLocalTextModelForSwitchResult> {
  const modelPath = config.localTextModelPaths?.[newModelName];
  if (!modelPath) return { handled: false, ok: true };

  const baseUrl = process.env.TEXT_MODEL_BASE_URL ?? process.env.FINANFA_BASE_URL ?? config.baseUrl;
  if (!baseUrl) return { handled: false, ok: true };

  try {
    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: newModelName,
      binary: process.env.TEXT_MODEL_BINARY ?? config.textModelBinary,
      contextSize: config.textModelContextSize ? Number(config.textModelContextSize) : undefined,
      restartIfDifferent: true,
    });
    reportLocalModelStatus(result, baseUrl, config, ui);
    const ok = result.state === "started" || result.state === "restarted" || result.state === "already-running-correct";
    return { handled: true, ok, status: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.writeError(`Failed to switch the local text model: ${message}`);
    return { handled: true, ok: false, status: { state: "start-failed", message } };
  }
}

/**
 * Optional second provider used only for the turn right after a vision tool
 * (browser_screenshot, view_image) returns an image — see VisionRoute in
 * loop.ts. Unset unless FINANFA_VISION_MODEL/config.visionModel is
 * configured; the primary provider's apiKey is never reused here, since it's
 * scoped to the primary provider's own service and reusing it for a
 * different provider kind would send the wrong secret to the wrong API.
 */
export function selectVisionProvider(config: FinanfaConfig): { provider: LlmProvider; model: string } | undefined {
  const model = process.env.VISION_MODEL_NAME ?? process.env.FINANFA_VISION_MODEL ?? config.visionModel;
  if (!model) return undefined;

  const kind = resolveProviderKindAlias(
    process.env.VISION_MODEL_PROVIDER ?? process.env.FINANFA_VISION_PROVIDER ?? config.visionProvider ?? "anthropic",
  );
  if (kind === "openai-compatible") {
    const baseUrl = process.env.VISION_MODEL_BASE_URL ?? process.env.FINANFA_VISION_BASE_URL ?? config.visionBaseUrl;
    const apiKey = process.env.FINANFA_VISION_API_KEY ?? config.visionApiKey;
    const streamIdleTimeoutMs = parseStreamIdleTimeoutMs(process.env.FINANFA_STREAM_IDLE_TIMEOUT_MS);
    if (!baseUrl) {
      throw new Error(
        "visionProvider openai-compatible requires a base URL — set VISION_MODEL_BASE_URL " +
          "(or the older FINANFA_VISION_BASE_URL), or /config set visionBaseUrl <url>.",
      );
    }
    return { provider: new OpenAiCompatibleProvider({ baseUrl, apiKey, streamIdleTimeoutMs }), model };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? config.visionApiKey;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID ?? config.anthropicWorkspaceId;
  return { provider: new AnthropicProvider(apiKey, workspaceId), model };
}

/**
 * Connects every configured MCP server that already has a saved token
 * (allowOAuthPrompt: false) and reports the rest as needing authorization
 * instead of popping a browser tab per server and blocking startup for up to
 * 5 minutes each — see NeedsAuthorizationError / McpClientManager.connect.
 */
export async function connectMcpServers(cwd: string, mcp: McpClientManager, ui: UIAdapter): Promise<{ needsAuth: string[] }> {
  const servers = await loadMcpServers(cwd);
  const needsAuth: string[] = [];
  for (const server of servers) {
    try {
      await mcp.connect(server, { allowOAuthPrompt: false });
    } catch (err) {
      if (err instanceof NeedsAuthorizationError) {
        needsAuth.push(server.name);
      } else {
        ui.writeError(`Failed to connect MCP server "${server.name}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  if (needsAuth.length > 0) {
    ui.writeSystem(`${needsAuth.length} MCP server(s) need authorization: ${needsAuth.join(", ")} — run /mcp connect <name> to use one.`);
  }
  return { needsAuth };
}
