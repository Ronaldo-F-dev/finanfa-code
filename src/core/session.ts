import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { NeutralMessage, UsageTotals } from "./types.js";
import { estimateCostUsd } from "./pricing.js";

export interface SessionFile {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  messages: NeutralMessage[];
  usage: UsageTotals;
}

const SESSIONS_ROOT = path.join(os.homedir(), ".finanfa-code", "sessions");

function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function sessionDir(cwd: string): string {
  return path.join(SESSIONS_ROOT, projectHash(cwd));
}

export class AgentSession {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly systemPrompt: string;
  messages: NeutralMessage[] = [];
  usage: UsageTotals = { inputTokens: 0, outputTokens: 0 };

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
    return session;
  }

  /** Lists session ids for `cwd`, most recently modified first. */
  static async list(cwd: string): Promise<{ id: string; mtime: Date }[]> {
    const dir = sessionDir(cwd);
    try {
      const entries = await readdir(dir);
      const withMtime = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => {
            const st = await stat(path.join(dir, entry));
            return { id: entry.replace(/\.json$/, ""), mtime: st.mtime };
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

  async persist(): Promise<void> {
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
    };
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, file);
  }
}
