import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { NeutralMessage, UsageTotals } from "./types.js";
import { estimateCostUsd } from "./pricing.js";
import { EditHistory } from "./edit-history.js";
import { TodoStore, type TodoItem } from "./todo-store.js";
import { FileFreshnessTracker } from "./file-freshness.js";
import { collectEnvSecretValues, redactSecrets } from "./redact.js";

export interface SessionFile {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  messages: NeutralMessage[];
  usage: UsageTotals;
  /** Short auto-generated summary (see maybeGenerateTitle in loop.ts) — undefined until the first exchange completes. */
  title?: string;
  /** Standing objective set via /goal, kept in the model's context every turn (see systemPromptWithDate in loop.ts) until /goal clear. */
  goal?: string;
  /**
   * Which provider family/endpoint `model` actually belongs to — set by
   * the web UI's /model switcher (see web-server's "set_model"), undefined
   * for a session that's never switched providers (the CLI has no such
   * switch; its one provider is fixed for the session's whole lifetime,
   * so this is always undefined there). Without persisting this, resuming
   * a session whose last-used model was a local/non-default provider
   * (crash, restart, page reload) reconstructs the provider from the
   * global/project default config instead — a real, reproduced bug: a
   * resumed session kept its local model's name but silently talked to
   * the default remote provider with it, which naturally rejected a model
   * name it had never heard of.
   */
  providerKind?: string;
  /** Only set for an openai-compatible provider pointed at a specific endpoint (a detected local runtime, or the one configured default) — undefined for Anthropic. */
  providerBaseUrl?: string;
  /**
   * A failed-turn message (see runTurn's catch block in loop.ts) never
   * became part of `messages` — it's UI-only, deliberately never sent back
   * to the model (appending it there would mean every later call resends
   * it as if it were part of the actual conversation). Without a place of
   * its own to persist, it was gone the moment the connection closed —
   * real, reported UX gap: reopening/resuming a session dropped every
   * error the model had hit during it, not just the ordinary chat text.
   * `afterMessageIndex` records where in `messages` it happened (that
   * array's length at the time), so a resume can replay it back in the
   * right position rather than all bunched at the start or end.
   */
  errorLog?: { text: string; afterMessageIndex: number }[];
  /** Set by the effort-tier picker (see EFFORT_TIERS in effort-tiers.ts) — caps provider output so a small/local model isn't asked to generate more than its own context can hold. Undefined uses each provider's own default. */
  maxTokens?: number;
  /** The effort tier ("low"/"medium"/"high") this session is currently on, if any — kept alongside maxTokens/model/providerBaseUrl purely so a resumed session's UI can show which tier is active without re-deriving it from the model name. */
  effort?: string;
  /** See AgentSession.thinkingBudgetTokens's own doc comment. */
  thinkingBudgetTokens?: number;
  /** The current todo_write checklist (see TodoStore) — persisted so a resumed session's board isn't always empty until the next todo_write call; restored into a fresh TodoStore on resume(). */
  todos?: TodoItem[];
  /** Which authenticated web-server user created this session (see web-server/src/auth.ts) — undefined for the CLI/VS Code/ACP entry points, which have no such concept, and for any session created before this field existed. Used to isolate one user's sessions from another's; never enforced by AgentSession itself, only by the web server's own request handlers. */
  ownerUser?: string;
}

// Computed lazily (not memoized as a module constant) so it reflects the
// current $HOME/os.homedir() at call time rather than whatever it was when
// this module first loaded — matters for tests that override $HOME (see
// core/config.ts's globalConfigPath for the same pattern/reasoning).
export function sessionsRoot(): string {
  return path.join(os.homedir(), ".finanfa-code", "sessions");
}

export function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export function sessionDir(cwd: string): string {
  return path.join(sessionsRoot(), projectHash(cwd));
}

export class AgentSession {
  readonly id: string;
  readonly cwd: string;
  /**
   * Mutable (unlike id/cwd/systemPrompt) so a frontend can offer switching
   * models mid-conversation, the way Claude.ai/ChatGPT do — runTurn always
   * reads session.model fresh per call, so a change takes effect on the very
   * next turn. Switching to a model from a different provider/family (e.g.
   * a detected local runtime) swaps the actual provider instance the web
   * server uses too — see providerKind/providerBaseUrl below, which is
   * where that gets recorded so it survives a resume.
   */
  model: string;
  readonly systemPrompt: string;
  title?: string;
  goal?: string;
  /** See SessionFile's own doc comment — set by the web UI's /model switcher whenever it changes provider, read back on resume so the right provider/endpoint is reconstructed instead of defaulting to the global/project config. */
  providerKind?: string;
  providerBaseUrl?: string;
  messages: NeutralMessage[] = [];
  usage: UsageTotals = { inputTokens: 0, outputTokens: 0 };
  readonly history = new EditHistory();
  readonly todos = new TodoStore();
  readonly fileFreshness = new FileFreshnessTracker();
  /** MCP server names currently excluded from the tool list sent to the model (still connected — /mcp enable brings them back without reconnecting). */
  readonly disabledMcpServers = new Set<string>();
  /** Built-in tool names excluded from the tool list sent to the model — e.g. a web UI's explicit "web search off"/"image generation off" toggles, distinct from disabledMcpServers (which only ever covers MCP-provided tools). */
  readonly disabledTools = new Set<string>();
  /**
   * When true, loop.ts sends only 3 meta-tools (search_tools/describe_tool/
   * call_tool — see tool-search.ts) instead of every available tool's full
   * schema, deferring the rest until the model actually asks for one. Real
   * gap this closes: the per-turn request otherwise scales with the TOTAL
   * number of available tools regardless of task relevance — measured
   * directly at 277s just to start answering with this project's full
   * ~180-tool list on a small local model, vs 3-5s with a handful. Not
   * persisted (a resumed session re-derives it from whether its current
   * provider looks local, same as the effort-tier picker already does),
   * same runtime-only convention as disabledTools/disabledMcpServers.
   */
  toolSearchEnabled = false;
  /**
   * When true, loop.ts's availableTools() also excludes every tool in
   * LOCAL_MODEL_LEAN_EXCLUDED_TOOLS (browser, automations, image/video/
   * audio generation, PDF conversion, messaging channels — see
   * local-model-lean.ts) — genuinely unreachable, not just hidden from
   * the schema list, so Tool Search's search_tools can't surface them
   * either. Same runtime-only, re-derived-on-resume convention as
   * toolSearchEnabled above.
   */
  localModelLeanEnabled = false;
  /**
   * One entry per currently-running tool call (see runOneToolCall in
   * loop.ts) — a Set, not a single controller, since "safe" tools run
   * concurrently via Promise.all. Runtime-only, never persisted: a fresh
   * session (or one loaded via resume()) always starts empty. Ctrl+C aborts
   * every entry here (see registerShutdownHandlers in cli.ts) so an
   * in-flight subprocess (bash, run_tests, ...) actually gets killed instead
   * of surviving as an orphan after the parent process exits.
   */
  readonly activeAbortControllers = new Set<AbortController>();
  /**
   * Runtime-only (never persisted, always false on a fresh/resumed
   * session), same as disabledTools/disabledMcpServers. Toggled via /plan;
   * while true, loop.ts auto-denies any tool call whose riskLevel isn't
   * "safe" (except exit_plan_mode itself) without even prompting — the
   * model can research freely but can't make changes until it presents a
   * plan via exit_plan_mode and the user approves it.
   */
  planMode = false;
  /**
   * One entry per user message this session, in order — recorded by
   * runTurn right when the message is appended, before any tool runs in
   * response to it. Runtime-only (never persisted; a resumed session
   * starts empty, same as history/disabledTools — nothing to rewind past
   * a point the in-memory edit history doesn't cover either). Backs
   * /rewind: messageIndex is where to truncate session.messages back to,
   * historySize is where to call session.history.revertTo() to undo every
   * file change made since.
   */
  checkpoints: { messageIndex: number; historySize: number; preview: string }[] = [];
  /** See SessionFile's own doc comment. Persisted (unlike checkpoints/history above) — the whole point is surviving a resume. */
  errorLog: { text: string; afterMessageIndex: number }[] = [];
  /** See SessionFile's own doc comment — set by the effort-tier picker, read back on resume. */
  maxTokens?: number;
  effort?: string;
  /** Set from config.thinkingBudgetTokens at construction (see each entry point) — read back on resume, same lifecycle as maxTokens/effort. Undefined disables Anthropic extended thinking entirely. */
  thinkingBudgetTokens?: number;
  /** See SessionFile's own doc comment. Set by the web server right after construction/resume when auth is configured; read back on resume. */
  ownerUser?: string;

  constructor(opts: { id?: string; cwd: string; model: string; systemPrompt: string }) {
    this.id = opts.id ?? randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
  }

  static async resume(cwd: string, sessionId: string, systemPrompt: string): Promise<AgentSession> {
    const file = path.join(sessionDir(cwd), `${sessionId}.json`);
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw) as SessionFile;
    const session = new AgentSession({
      id: data.id,
      cwd: data.cwd,
      model: data.model,
      systemPrompt,
    });
    session.messages = data.messages;
    session.usage = data.usage;
    session.title = data.title;
    session.goal = data.goal;
    session.providerKind = data.providerKind;
    session.providerBaseUrl = data.providerBaseUrl;
    session.errorLog = data.errorLog ?? [];
    session.maxTokens = data.maxTokens;
    session.effort = data.effort;
    session.thinkingBudgetTokens = data.thinkingBudgetTokens;
    if (data.todos) session.todos.set(data.todos);
    session.ownerUser = data.ownerUser;
    return session;
  }

  /** Lists sessions for `cwd`, most recently modified first. title is undefined for a session with no completed exchange yet, or an unreadable/corrupted file. ownerUser is undefined for a session created with no authenticated web-server user (see SessionFile's own doc comment) — every CLI/VS Code/ACP session, and any session predating this field. */
  static async list(cwd: string): Promise<{ id: string; mtime: Date; title?: string; ownerUser?: string }[]> {
    const dir = sessionDir(cwd);
    try {
      const entries = await readdir(dir);
      const withMtime = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => {
            const filePath = path.join(dir, entry);
            const st = await stat(filePath);
            const parsed = await readFile(filePath, "utf-8")
              .then((raw) => JSON.parse(raw) as SessionFile)
              .catch(() => undefined);
            return { id: entry.replace(/\.json$/, ""), mtime: st.mtime, title: parsed?.title, ownerUser: parsed?.ownerUser };
          }),
      );
      return withMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    } catch {
      return [];
    }
  }

  static async findLatest(cwd: string): Promise<string | undefined> {
    const sessions = await AgentSession.list(cwd);
    return sessions[0]?.id;
  }

  static async delete(cwd: string, sessionId: string): Promise<void> {
    await rm(path.join(sessionDir(cwd), `${sessionId}.json`), { force: true });
  }

  /** A lightweight ownership check — reads just enough to answer "who owns this session?" without the full resume() (systemPrompt, redaction, etc.). Undefined for a nonexistent/unreadable session file, same as a session with no owner recorded. */
  static async ownerOf(cwd: string, sessionId: string): Promise<string | undefined> {
    try {
      const raw = await readFile(path.join(sessionDir(cwd), `${sessionId}.json`), "utf-8");
      return (JSON.parse(raw) as SessionFile).ownerUser;
    } catch {
      return undefined;
    }
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;
  }

  get costUsd(): number {
    return estimateCostUsd(this.model, this.usage.inputTokens, this.usage.outputTokens);
  }

  // Scrubs secret-shaped/denylisted values (see redact.ts) out of every text
  // field that a tool's raw output or an error message could have leaked
  // one into, before the session ever touches disk — resume/search-index
  // both re-read this same file (see resume() and session-search-index.ts),
  // so this one choke point covers both.
  private redactSessionFile(data: SessionFile): SessionFile {
    const denylist = collectEnvSecretValues();
    return {
      ...data,
      messages: data.messages.map((message) => {
        if (message.role === "tool") {
          return { ...message, results: message.results.map((result) => ({ ...result, content: redactSecrets(result.content, denylist) })) };
        }
        return { ...message, content: redactSecrets(message.content, denylist) };
      }),
      errorLog: data.errorLog?.map((entry) => ({ ...entry, text: redactSecrets(entry.text, denylist) })),
      todos: data.todos?.map((todo) => ({ ...todo, content: redactSecrets(todo.content, denylist) })),
    };
  }

  // Called after every turn (see loop.ts/cli.ts) so a crash mid-conversation
  // loses as little as possible — but a disk-full or permission error here
  // used to propagate up and crash the turn outright, which is worse than
  // just failing to save: the user loses the *rest* of the conversation too,
  // not just resumability. Warn and keep going, same convention as
  // config.ts's readJsonIfExists.
  async persist(): Promise<void> {
    try {
      const dir = sessionDir(this.cwd);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${this.id}.json`);
      const tmp = `${file}.tmp`;
      const data: SessionFile = {
        id: this.id,
        createdAt: new Date().toISOString(),
        cwd: this.cwd,
        model: this.model,
        messages: this.messages,
        usage: this.usage,
        title: this.title,
        goal: this.goal,
        providerKind: this.providerKind,
        providerBaseUrl: this.providerBaseUrl,
        errorLog: this.errorLog,
        maxTokens: this.maxTokens,
        effort: this.effort,
        thinkingBudgetTokens: this.thinkingBudgetTokens,
        todos: this.todos.list(),
        ownerUser: this.ownerUser,
      };
      await writeFile(tmp, JSON.stringify(this.redactSessionFile(data), null, 2), "utf-8");
      await rename(tmp, file);
    } catch (err) {
      console.error(`Warning: failed to save session state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
