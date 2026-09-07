import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { NeutralMessage, UsageTotals } from "./types.js";
import { estimateCostUsd } from "./pricing.js";
import { EditHistory } from "./edit-history.js";
import { TodoStore } from "./todo-store.js";
import { FileFreshnessTracker } from "./file-freshness.js";

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
   * next turn. Only meaningful within the same provider/family (switching
   * from an Anthropic model to another Anthropic model, say) — the provider
   * instance itself is chosen once per session and isn't swapped here.
   */
  model: string;
  readonly systemPrompt: string;
  title?: string;
  goal?: string;
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
   * One entry per currently-running tool call (see runOneToolCall in
   * loop.ts) — a Set, not a single controller, since "safe" tools run
   * concurrently via Promise.all. Runtime-only, never persisted: a fresh
   * session (or one loaded via resume()) always starts empty. Ctrl+C aborts
   * every entry here (see registerShutdownHandlers in cli.ts) so an
   * in-flight subprocess (bash, run_tests, ...) actually gets killed instead
   * of surviving as an orphan after the parent process exits.
   */
  readonly activeAbortControllers = new Set<AbortController>();

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
    return session;
  }

  /** Lists sessions for `cwd`, most recently modified first. title is undefined for a session with no completed exchange yet, or an unreadable/corrupted file. */
  static async list(cwd: string): Promise<{ id: string; mtime: Date; title?: string }[]> {
    const dir = sessionDir(cwd);
    try {
      const entries = await readdir(dir);
      const withMtime = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => {
            const filePath = path.join(dir, entry);
            const st = await stat(filePath);
            const title = await readFile(filePath, "utf-8")
              .then((raw) => (JSON.parse(raw) as SessionFile).title)
              .catch(() => undefined);
            return { id: entry.replace(/\.json$/, ""), mtime: st.mtime, title };
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

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;
  }

  get costUsd(): number {
    return estimateCostUsd(this.model, this.usage.inputTokens, this.usage.outputTokens);
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
      };
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
      await rename(tmp, file);
    } catch (err) {
      console.error(`Warning: failed to save session state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
